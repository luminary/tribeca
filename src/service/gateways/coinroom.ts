/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />
///<reference path="../config.ts"/>
///<reference path="../utils.ts"/>
///<reference path="../interfaces.ts"/>

import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
import log from "../logging";
var shortId = require("shortid");
var Deque = require("collections/deque");

interface CoinRoomMarketTradeRequest {
    market: string,
}

interface CoinRoomMarketTrade {
    id: number;
    created_at: number;
    price: number;
    volume: number;
    side: string;
}

interface CoinRoomMarketLevel {
    price: string;
    volume: string;
    created_at: string;
}

interface CoinRoomOrderBookRequest {
    market: string,
    asks_limit: number,
    bids_limit: number,
}

interface CoinRoomOrderBook {
    asks: CoinRoomMarketLevel[];
    bids: CoinRoomMarketLevel[];
}

function decodeSide(side: string) {
    switch (side) {
        case "buy": return Models.Side.Bid;
        case "sell": return Models.Side.Ask;
        default: return Models.Side.Unknown;
    }
}

function encodeSide(side: Models.Side) {
    switch (side) {
        case Models.Side.Bid: return "buy";
        case Models.Side.Ask: return "sell";
        default: return "";
    }
}

class CoinRoomMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private _since: number = null;
    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrades = (trades: Models.Timestamped<CoinRoomMarketTrade[]>) => {
        _.forEach(trades.data, trade => {
            const lastTradeId = this._lastTradeId[this._symbolProvider.symbol];
            if(!lastTradeId || trade.id > lastTradeId ){
                this._lastTradeId[this._symbolProvider.symbol] = trade.id;
            }

            var px = trade.price;
            var sz = trade.volume;
            var time = moment.utc(trade.created_at).toDate();
            var side = decodeSide(trade.side);
            var mt = new Models.GatewayMarketTrade(px, sz, time, this._since === null, side);
            this.MarketTrade.trigger(mt);
        });

        this._since = moment().unix();
    };

    private downloadMarketTrades = () => {
        const lastTradeId = this._lastTradeId[this._symbolProvider.symbol];
        const qs =
            lastTradeId ?
                { market: this._symbolProvider.symbol, from: lastTradeId }
            :   { market: this._symbolProvider.symbol, limit: 30 }; // try only get upto 30 trades on startup

        this._http
            .get<CoinRoomMarketTradeRequest, CoinRoomMarketTrade[]>("/api/v2/trades", qs)
            .then(this.onTrades)
            .done();
    };

    private static ConvertToMarketSide(level: CoinRoomMarketLevel): Models.MarketSide {
        return new Models.MarketSide(parseFloat(level.price), parseFloat(level.volume), "CoinR");
    }

    private static ConvertToMarketSides(level: CoinRoomMarketLevel[]): Models.MarketSide[] {
        return _.map(level, CoinRoomMarketDataGateway.ConvertToMarketSide);
    }

    private _log = log("tribeca:gateway:CoinRoomMD");
    MarketData = new Utils.Evt<Models.Market>();
    private onMarketData = (book: Models.Timestamped<CoinRoomOrderBook>) => {
        var bids = CoinRoomMarketDataGateway.ConvertToMarketSides(book.data.bids);
        var asks = CoinRoomMarketDataGateway.ConvertToMarketSides(book.data.asks);
        this.MarketData.trigger(new Models.Market(bids, asks, book.time));
    };

    private downloadMarketData = () => {
        const qs: CoinRoomOrderBookRequest = {
            market:this._symbolProvider.symbol,
            asks_limit: 10,
            bids_limit: 10,
        };
        this._http
            .get<CoinRoomOrderBookRequest, CoinRoomOrderBook>("/api/v2/order_book", qs)
            .then(this.onMarketData)
            .done();
    };

    private _lastTradeId = new Map<string, number>();
    constructor(
        timeProvider: Utils.ITimeProvider,
        private _http: CoinRoomHttp,
        private _symbolProvider: CoinRoomSymbolProvider) {

        timeProvider.setInterval(this.downloadMarketData, moment.duration(500, "seconds"));
        timeProvider.setInterval(this.downloadMarketTrades, moment.duration(1500, "seconds"));

        this.downloadMarketData();
        this.downloadMarketTrades();

        _http.ConnectChanged.on(s => this.ConnectChanged.trigger(s));
    }
}

interface RejectableResponse {
    message: string;
}

interface CoinRoomNewOrderRequest {
    market: string;
    volume: string;
    price: string; //Price to buy or sell at. Must be positive. Use random number for market orders.
    side: string;  //buy or sell
}

interface CoinRoomNewOrderResponse extends RejectableResponse {
    id: string;
}

interface CoinRoomCancelOrderRequest {
    id: string;
}
interface CoinRoomOrderStatusRequest {
    id: string;
    market: string;
}

interface CoinRoomMyTradesRequest {
    market: string,
    limit?: number,
    from?: number,
    to?: number,
    timestamp?: number, // seconds since epoch, get trades by this time point
}

interface CoinRoomMyTradesResponse extends RejectableResponse {
    price: string;
    volume: string;
    created_at: number;
    side: string;
    id: number;
    market: string;
    order_id: string;
}

interface CoinRoomOrderStatusResponse extends RejectableResponse {
    id: string;
    market: string;
    price: number;
    avg_price: string;
    side: string;
    ord_type: string; // "market" / "limit" / "stop" / "trailing-stop".
    created_at: string;
    state: string;
    executed_volume: string;
    remaining_volume: string;
    volume: string;
}

class CoinRoomOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    supportsCancelAllOpenOrders = () : boolean => { return true; };
    cancelAllOpenOrders = () : Q.Promise<number> => {
        var d = Q.defer<number>();
        this._http
            .post<{}, CoinRoomOrderStatusResponse[]>("/api/v2/orders/clear", {})
            .then(resp => {
                for (let order of resp.data) {
                    this.OrderUpdate.trigger({
                        exchangeId: order.id,
                        time: resp.time,
                        orderStatus: CoinRoomOrderEntryGateway.GetOrderStatus(order),
                        leavesQuantity: parseFloat(order.remaining_volume),
                    });
                }
                d.resolve(resp.data.length);
            })
            .done();
        return d.promise;
    };

    generateClientOrderId = () => shortId.generate();

    public cancelsByClientOrderId = false;

    private convertToOrderRequest = (order: Models.OrderStatusReport): CoinRoomNewOrderRequest => {
        return {
            volume: order.quantity.toString(),
            price: order.price.toString(),
            side: encodeSide(order.side),
            market: this._symbolProvider.symbol
        };
    }

    sendOrder = (order: Models.OrderStatusReport) => {
        var req = this.convertToOrderRequest(order);

        this._http
            .post<CoinRoomNewOrderRequest, CoinRoomNewOrderResponse>("/api/v2/orders", req)
            .then(resp => {
                this.OrderUpdate.trigger({
                    orderId: order.orderId,
                    exchangeId: resp.data.id,
                    time: resp.time,
                    orderStatus: Models.OrderStatus.New,
                });
                this._log.info("Received order ack data: ", resp);
            })
            .done();

        this.OrderUpdate.trigger({
            orderId: order.orderId,
            computationalLatency: Utils.fastDiff(new Date(), order.time)
        });
    };

    cancelOrder = (cancel: Models.OrderStatusReport) => {
        var req = { id: cancel.exchangeId };
        this._http
            .post<CoinRoomCancelOrderRequest, CoinRoomOrderStatusResponse>("/api/v2/order/delete", req)
            .then(resp => {
                this._log.info("Received cancel ack data: ", resp);

                this.OrderUpdate.trigger({
                    orderId: cancel.orderId,
                    time: resp.time,
                    orderStatus: CoinRoomOrderEntryGateway.GetOrderStatus(resp.data),
                });
            })
            .done();

        this.OrderUpdate.trigger({
            orderId: cancel.orderId,
            computationalLatency: Utils.fastDiff(new Date(), cancel.time)
        });
    };

    replaceOrder = (replace: Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    };

    private downloadOrderStatuses = () => {
        const tradesReq =
            this._myLastTradeId.has(this._symbolProvider.symbol)
            ?   { market: this._symbolProvider.symbol, from: this._myLastTradeId[this._symbolProvider.symbol] }
            :   { market: this._symbolProvider.symbol };

        this._http
            .get<CoinRoomMyTradesRequest, CoinRoomMyTradesResponse[]>("/api/v2/trades/my", tradesReq)
            .then(resps => {
                _.forEach(resps.data, t => {
                    const orderReq = { id: t.order_id, market: this._symbolProvider.symbol };
                    this._http
                        .get<CoinRoomOrderStatusRequest, CoinRoomOrderStatusResponse>("/api/v2/order", orderReq)
                        .then(r => {
                            const orderStatus = CoinRoomOrderEntryGateway.GetOrderStatus(r.data);
                            if(orderStatus == Models.OrderStatus.Complete){
                                this._myLastTradeId[this._symbolProvider.symbol] = Math.max(t.id, this._myLastTradeId[this._symbolProvider.symbol]);
                            }
                            this.OrderUpdate.trigger({
                                exchangeId: t.order_id,
                                lastPrice: parseFloat(t.price),
                                lastQuantity: parseFloat(t.volume),
                                orderStatus: CoinRoomOrderEntryGateway.GetOrderStatus(r.data),
                                averagePrice: parseFloat(r.data.avg_price),
                                leavesQuantity: parseFloat(r.data.remaining_volume),
                                cumQuantity: parseFloat(r.data.executed_volume),
                                quantity: parseFloat(r.data.volume)
                            });

                        })
                        .done();
                });
            })
            .done();

        this._since = moment.utc();
    };

    private downloadTradeStatuses = () => {
        const tradesReq =
            this._myLastTradeId.has(this._symbolProvider.symbol)
            ?   { market: this._symbolProvider.symbol, from: this._myLastTradeId[this._symbolProvider.symbol] }
            :   { market: this._symbolProvider.symbol };

        this._http
            .get<CoinRoomMyTradesRequest, CoinRoomMyTradesResponse[]>("/api/v2/trades/my", tradesReq)
            .then(resps => {
                _.forEach(resps.data, t => {
                    const orderReq = { id: t.order_id, market: this._symbolProvider.symbol };
                    this._http
                        .get<CoinRoomOrderStatusRequest, CoinRoomOrderStatusResponse>("/api/v2/order", orderReq)
                        .then(r => {
                            const orderStatus = CoinRoomOrderEntryGateway.GetOrderStatus(r.data);
                            if(orderStatus == Models.OrderStatus.Complete){
                                this._myLastTradeId[this._symbolProvider.symbol] = Math.max(t.id, this._myLastTradeId[this._symbolProvider.symbol]);
                            }
                            this.OrderUpdate.trigger({
                                exchangeId: t.order_id,
                                lastPrice: parseFloat(t.price),
                                lastQuantity: parseFloat(t.volume),
                                orderStatus: CoinRoomOrderEntryGateway.GetOrderStatus(r.data),
                                averagePrice: parseFloat(r.data.avg_price),
                                leavesQuantity: parseFloat(r.data.remaining_volume),
                                cumQuantity: parseFloat(r.data.executed_volume),
                                quantity: parseFloat(r.data.volume)
                            });

                        })
                        .done();
                });
            })
            .done();

        this._since = moment.utc();
    };

    private static GetOrderStatus(r: CoinRoomOrderStatusResponse) {
        if (r.state === 'cancel') return Models.OrderStatus.Cancelled;
        if (r.state === 'wait') return Models.OrderStatus.Working;
        if (r.state === 'done') return Models.OrderStatus.Complete;
        return Models.OrderStatus.Other;
    }

    private _since = moment.utc();
    private _myLastTradeId = new Map<string, number>();
    private _log = log("tribeca:gateway:CoinRoomOE");
    constructor(
        timeProvider: Utils.ITimeProvider,
        private _details: CoinRoomBaseGateway,
        private _http: CoinRoomHttp,
        private _symbolProvider: CoinRoomSymbolProvider) {

        _http.ConnectChanged.on(s => this.ConnectChanged.trigger(s));
        timeProvider.setInterval(this.downloadTradeStatuses, moment.duration(300, "seconds"));
        timeProvider.setInterval(this.downloadOrderStatuses, moment.duration(300, "seconds"));
    }
}


class RateLimitMonitor {
    private _log = log("tribeca:gateway:rlm");

    private _queue = Deque();
    private _durationMs: number;

    public add = () => {
        var now = moment.utc();

        while (now.diff(this._queue.peek()) > this._durationMs) {
            this._queue.shift();
        }

        this._queue.push(now);

        if (this._queue.length > this._number) {
            this._log.error("Exceeded rate limit", { nRequests: this._queue.length, max: this._number, durationMs: this._durationMs });
        }
    }

    constructor(private _number: number, duration: moment.Duration) {
        this._durationMs = duration.asMilliseconds();
    }
}

class CoinRoomHttp {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private _timeout = 150000;

    private nonce: () => string = (function() {
      let prev = 0;
      return function() {
        var n = Date.now();
        if (n == this._nonce)
        {
            n += 1;
        }
        if (n <= prev) {
          prev += 1;
          this._nonce = prev;
          return prev.toString();
        }
        prev = n;
        this._nonce = prev;
        return prev.toString();
      };
    })();

    private hmac(secret: string, text: string, algo: string = 'sha256'): string {
      return crypto
        .createHmac(algo, secret)
        .update(text)
        .digest('hex');
    }

    private safeQueryStringStringify(o: any) {
      const noUndefinedFields = _.pickBy(o, _.negate(_.isUndefined));
      return querystring.stringify(noUndefinedFields);
    }

    private signParams<T>(method: string, path: string, qs: any) {
      qs.tonce = this.nonce();
      qs.access_key = this._apiKey;
      const param = this.safeQueryStringStringify(qs);
      const sortedParam = param.split('&').sort().join('&');
      const message = method + "|" + path + "|" + sortedParam;
      const signature = this.hmac(this._secret, message);
      qs.signature = signature;
      return qs;
    }

    get = <TRequest, TResponse>(actionUrl: string, qs?: TRequest): Q.Promise<Models.Timestamped<TResponse>> => {
        qs = this.signParams("GET", actionUrl, qs);
        const url = this._baseUrl + actionUrl;

        var opts = {
            timeout: this._timeout,
            url: url,
            qs: qs || undefined,
            json: true,
            method: "GET",
            pool: {maxSockets: 10},
        };

        this._log.info("GET query: ", actionUrl, qs);

        return this.doRequest<TResponse>(opts, url);
    };

    post = <TRequest, TResponse>(actionUrl: string, msg: TRequest): Q.Promise<Models.Timestamped<TResponse>> => {
        const signedParam = this.signParams("POST", actionUrl, msg);

        const url = this._baseUrl + actionUrl;
        var opts = {
            timeout: this._timeout,
            url: url,
            form: signedParam || undefined,
            json: true,
            method: "POST",
            pool: {maxSockets: 1000},
        };

        this._log.info("POST query: ", actionUrl, signedParam);

        return this.doRequest<TResponse>(opts, url);
    };

    private doRequest = <TResponse>(msg: request.Options, url: string): Q.Promise<Models.Timestamped<TResponse>> => {
        var d = Q.defer<Models.Timestamped<TResponse>>();

        this._monitor.add();
        request(msg, (err, resp, body) => {
            if (err) {
                this._log.error(err, "Error returned: url=", url, ", opts=", msg, ", body=", body, "err=", err);
                d.reject(err);
            }
            else {
                try {
                    var t = new Date();
                    this._log.debug("Raw data before JSON decoder url=", url, ", opts=", msg, ", body=", body);
                    d.resolve(new Models.Timestamped(body, t));
                }
                catch (err) {
                    this._log.error(err, "Error parsing JSON url=", url, ", opts=", msg, ", body=", body, "err=", err);
                    d.reject(err);
                }
            }
        });

        return d.promise;
    };

    private _log = log("tribeca:gateway:CoinRoomHTTP");
    private _baseUrl: string;
    private _apiKey: string;
    private _secret: string;
    private _nonce: number;

    constructor(config: Config.IConfigProvider, private _monitor: RateLimitMonitor) {
        this._baseUrl = config.GetString("CoinRoomHttpUrl")
        this._apiKey = config.GetString("CoinRoomApiKey");
        this._secret = config.GetString("CoinRoomSecret");

        this._nonce = new Date().valueOf();
        this._log.info("Starting nonce: ", this._nonce);
        setTimeout(() => this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected), 10);
    }
}

interface CoinRoomAccountPositionResponseItem {
    currency: string;
    balance: string;
    locked: string;
}

interface CoinRoomAccountResponse {
  sn: string,
  name?: string,
  email: string,
  activated: boolean,
  accounts: CoinRoomAccountPositionResponseItem[],
}

class CoinRoomPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private onRefreshPositions = () => {
        this._http
            .get<{}, CoinRoomAccountResponse>("/api/v2/members/me", {})
            .then(res => {
                this._log.info("Received position data:", res.data);
                _.forEach(res.data.accounts, p => {
                    var amt = parseFloat(p.balance);
                    var cur = Models.toCurrency(p.currency);
                    var held = parseFloat(p.locked);
                    var rpt = new Models.CurrencyPosition(amt, held, cur);
                    this.PositionUpdate.trigger(rpt);
                });
            })
            .done();
    }

    private _log = log("tribeca:gateway:CoinRoomPG");
    constructor(timeProvider: Utils.ITimeProvider, private _http: CoinRoomHttp) {
        timeProvider.setInterval(this.onRefreshPositions, moment.duration(10, "seconds"));
        this.onRefreshPositions();
    }
}

class CoinRoomBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name(): string {
        return "CoinRoom";
    }

    makeFee(): number {
        return 0.001;
    }

    takeFee(): number {
        return 0.002;
    }

    exchange(): Models.Exchange {
        return Models.Exchange.CoinRoom;
    }

    constructor(public minTickIncrement: number) {}
}

class CoinRoomSymbolProvider {
    public symbol: string;

    constructor(pair: Models.CurrencyPair) {
        this.symbol = Models.fromCurrency(pair.base).toLowerCase() + Models.fromCurrency(pair.quote).toLowerCase();
    }
}

class CoinRoom extends Interfaces.CombinedGateway {
    constructor(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, symbol: CoinRoomSymbolProvider) {
        const monitor = new RateLimitMonitor(60, moment.duration(1, "minutes"));
        const http = new CoinRoomHttp(config, monitor);
        const details = new CoinRoomBaseGateway(0.000001); //TODO need to refactor to handle tick size

        const orderGateway = config.GetString("CoinRoomOrderDestination") == "CoinRoom"
            ? <Interfaces.IOrderEntryGateway>new CoinRoomOrderEntryGateway(timeProvider, details, http, symbol)
            : new NullGateway.NullOrderGateway();

        super(
            new CoinRoomMarketDataGateway(timeProvider, http, symbol),
            orderGateway,
            new CoinRoomPositionGateway(timeProvider, http),
            details,
        );
    }
}

interface SymbolDetails {
    id: string,
    name:string,
    base_unit:string,
    quote_unit:string,
}

export async function createCoinRoom(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    const detailsUrl = config.GetString("CoinRoomHttpUrl")+"/api/v2/markets";
    const symbolDetails = await Utils.getJSON<SymbolDetails[]>(detailsUrl);
    const symbol = new CoinRoomSymbolProvider(pair);

    for (let s of symbolDetails) {
        if (s.id === symbol.symbol)
            return new CoinRoom(timeProvider, config, symbol);
    }

    throw new Error("cannot match pair to a CoinRoom Symbol " + pair.toString());
}
