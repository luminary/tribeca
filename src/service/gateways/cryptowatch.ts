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

interface CryptoWatchAllowance {
  cost: number,
  remaining: number,
}

interface CryptoWatchResponse<T> {
  result: T, // data
  allowance: CryptoWatchAllowance,
}

interface CryptoWatchMarketTrade {
    data: string[], // [id, time, price, qty]
}

interface CryptoWatchMarketLevel {
    data: string[]; // [price, qty]
}

interface CryptoWatchOrderBook {
    asks: CryptoWatchMarketLevel[];
    bids: CryptoWatchMarketLevel[];
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

export class CryptoWatchMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private _since: number = null;
    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrades = (trades: Models.Timestamped<CryptoWatchMarketTrade[]>) => {
        _.forEach(trades.data, trade => {
            var px = parseFloat(trade[2]);
            var sz = parseFloat(trade[3]);
            var time = moment.unix(trade[1]).toDate();
            var mt = new Models.GatewayMarketTrade(px, sz, time, this._since === null, Models.Side.Unknown);
            this.MarketTrade.trigger(mt);
        });

        this._since = moment().unix();
    };

    private downloadMarketTrades = () => {
        var qs = {};

        _.forEach(this._exchanges, exchange => {
          this._http
              .get<CryptoWatchMarketTrade[]>("/markets/" + Models.Exchange[exchange] + "/" + this._symbolProvider.symbol + "/trades", qs)
              .then(this.onTrades)
              .done();
        });
    };

    private static ConvertToMarketSide(exchange: string, level: CryptoWatchMarketLevel): Models.MarketSide {
        return new Models.MarketSide(parseFloat(level[0]), parseFloat(level[1]), exchange);
    }

    private static ConvertToMarketSides(cryptoWatchExchange: string, level: CryptoWatchMarketLevel[]): Models.MarketSide[] {
        return _.map(level, (l) => {
            return CryptoWatchMarketDataGateway.ConvertToMarketSide(cryptoWatchExchange, l);
        });
    }

    MarketData = new Utils.Evt<Models.Market>();

    private cachedBooks = new Map<string, Models.MarketSide[][]>();

    private onMarketData = (cryptoWatchExchange: string, book: Models.Timestamped<CryptoWatchOrderBook>) => {
        var bids = CryptoWatchMarketDataGateway.ConvertToMarketSides(cryptoWatchExchange, book.data.bids.slice(0, 10));
        var asks = CryptoWatchMarketDataGateway.ConvertToMarketSides(cryptoWatchExchange, book.data.asks.slice(0, 10));

        this.cachedBooks.set(cryptoWatchExchange, [bids, asks]);

        var merged_bids: Models.MarketSide[] = [];
        var merged_asks: Models.MarketSide[] = [];
        this.cachedBooks.forEach((book, cryptoWatchExchange) => {
            merged_bids = merged_bids.concat(book[0]);
            merged_asks = merged_asks.concat(book[1]);
        });

        this._log.info("BIDS: ", merged_bids);
        this._log.info("ASKS: ", merged_asks);

        merged_bids.sort((a, b) => b.price - a.price);
        merged_asks.sort((a, b) => a.price - b.price);

        this._log.info("SORTED BIDS: ", merged_bids);
        this._log.info("SORTED ASKS: ", merged_asks);

        this.MarketData.trigger(new Models.Market(merged_bids, merged_asks, book.time));
    };

    private downloadMarketData = () => {
        var qs = {};
        _.forEach(this._exchanges, cryptoWatchExchange => {
          this._http
            .get<CryptoWatchOrderBook>("/markets/" + cryptoWatchExchange + "/" + this._symbolProvider.symbol + "/orderbook", qs)
            .then((data) => {
                this.onMarketData(cryptoWatchExchange, data);
            })
            .done();
        });
    };

    private _log = log("tribeca:gateway:CyptoWatchMD");
    constructor(
        timeProvider: Utils.ITimeProvider,
        config: Config.IConfigProvider,
        private _http: CryptoWatchHttp,
        private _symbolProvider: CryptoWatchSymbolProvider,
        private _exchanges: string[]) {

        timeProvider.setInterval(this.downloadMarketData, moment.duration(5, "seconds"));
        timeProvider.setInterval(this.downloadMarketTrades, moment.duration(15, "seconds"));

        this.downloadMarketData();
        this.downloadMarketTrades();

        _http.ConnectChanged.on(s => this.ConnectChanged.trigger(s));
    }
}

export class CryptoWatchHttp {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private _timeout = 150000;

    get = <T>(actionUrl: string, qs?: any, baseUrl?: string): Q.Promise<Models.Timestamped<T>> => {
        const url = this._baseUrl + actionUrl;

        var opts = {
            timeout: this._timeout,
            url: url,
            qs: qs || undefined,
            json: true,
            method: "GET",
            pool: {maxSockets: 1000},
        };

        this._log.info("GET query: ", actionUrl, qs);

        return this.doRequest<T>(opts, url);
    };

    private doRequest = <TResponse>(msg: request.Options, url: string): Q.Promise<Models.Timestamped<TResponse>> => {
        var d = Q.defer<Models.Timestamped<TResponse>>();

//        this._monitor.add();
        request(msg, (err, resp, body) => {
            if (err) {
                this._log.error(err, "Error returned: url=", url, ", opts=", msg, ", body=", body, "err=", err);
                d.reject(err);
            }
            else {
                try {
                    var t = new Date();
                    this._log.debug("Raw data before JSON decoder url=", url, ", opts=", msg, ", body=", body);
                    var data = body.result;
                    d.resolve(new Models.Timestamped(data, t));
                }
                catch (err) {
                    this._log.error(err, "Error parsing JSON url=", url, ", opts=", msg, ", body=", body, "err=", err);
                    d.reject(err);
                }
            }
        });

        return d.promise;
    };

    private _log = log("tribeca:gateway:CryptoWatchHTTP");
    private _baseUrl: string;

//    constructor(config: Config.IConfigProvider, private _monitor: RateLimitMonitor) {
// TODO add monitor
    constructor(config: Config.IConfigProvider) {
        this._baseUrl = config.GetString("CryptoWatchHttpUrl")

        setTimeout(() => this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected), 10);
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

class CryptoWatchBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name(): string {
        return "CryptoWatch";
    }

    makeFee(): number {
        return 0.001;
    }

    takeFee(): number {
        return 0.002;
    }

    exchange(): Models.Exchange {
        return Models.Exchange.CryptoWatch;
    }

    constructor(public minTickIncrement: number) {}
}

class CryptoWatchSymbolProvider {
    public symbol: string;

    constructor(pair: Models.CurrencyPair) {
        this.symbol = Models.fromCurrency(pair.base).toLowerCase() + Models.fromCurrency(pair.quote).toLowerCase();
    }
}


interface CryptoWatchExchangeRoute {
    price: string,
    summary: string,
    orderbook: string,
    trades: string,
    ohlc: string,
}

interface CryptoWatchExchangeProductDetails {
    id: string,
    exchange: string,
    pair: string,
    active: boolean,
    routes: CryptoWatchExchangeRoute
}

class CryptoWatch extends Interfaces.CombinedGateway {
    constructor(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, symbol: CryptoWatchSymbolProvider, exchanges: string[]) {
        const monitor = new RateLimitMonitor(60, moment.duration(1, "minutes"));
        const http = new CryptoWatchHttp(config);
        const details = new CryptoWatchBaseGateway(0.000001); //TODO need to refactor to handle tick size

        super(
            new CryptoWatchMarketDataGateway(timeProvider, config, http, symbol, exchanges),
            null,
            null,
            details,
        );
    }
}

export async function createCryptoWatch(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {

    const exchanges = config.GetString("CryptoWatchMarkets").split(",");
    const symbol = new CryptoWatchSymbolProvider(pair);

    for (let e of exchanges) {
        const detailsPairUrl = config.GetString("CryptoWatchHttpUrl") + "/markets/" + e + "/" + symbol.symbol;
        const symbolExchangeDetails = await Utils.getJSON<CryptoWatchResponse<CryptoWatchExchangeProductDetails>>(detailsPairUrl);

        if (!symbolExchangeDetails || !symbolExchangeDetails.result.active) {
            throw new Error("Configured CryptoWatch exchange [" + e + "] does not support [" + pair.toString() + "]");
        }
    }

    return new CryptoWatch(timeProvider, config, symbol, exchanges);
}
