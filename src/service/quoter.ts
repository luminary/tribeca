/// <reference path="../common/models.ts" />
/// <reference path="config.ts" />
/// <reference path="utils.ts" />
///<reference path="interfaces.ts"/>

import * as moment from "moment";
import Config = require("./config");
import Models = require("../common/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");

class QuoteOrder {
    constructor(public quote: Models.Quote, public orderId: string) { }
}

class QuotePlacement {
    constructor(public quote: Models.Quote, public orderIds: Set<string>) { }
}

// aggregator for quoting
export class Quoter {
    private _bidQuoter: ExchangeQuoter;
    private _askQuoter: ExchangeQuoter;

    constructor(broker: Interfaces.IOrderBroker,
        exchBroker: Interfaces.IBroker) {
        this._bidQuoter = new ExchangeQuoter(broker, exchBroker, Models.Side.Bid);
        this._askQuoter = new ExchangeQuoter(broker, exchBroker, Models.Side.Ask);
    }

    public updateQuote = (q: Models.Timestamped<Models.Quote>, side: Models.Side): Models.QuoteSent => {
        switch (side) {
            case Models.Side.Ask:
                return this._askQuoter.updateQuote(q);
            case Models.Side.Bid:
                return this._bidQuoter.updateQuote(q);
        }
    };

    public cancelQuote = (s: Models.Timestamped<Models.Side>): Models.QuoteSent => {
        switch (s.data) {
            case Models.Side.Ask:
                return this._askQuoter.cancelQuote(s.time);
            case Models.Side.Bid:
                return this._bidQuoter.cancelQuote(s.time);
        }
    };

    public quotesSent = (s: Models.Side) => {
        switch (s) {
            case Models.Side.Ask:
                return this._askQuoter.quotesSent;
            case Models.Side.Bid:
                return this._bidQuoter.quotesSent;
        }
    };
}

// wraps a single broker to make orders behave like quotes
export class ExchangeQuoter {
    private _activeQuote: QuotePlacement = null;
    private _exchange: Models.Exchange;

    public quotesSent: QuotePlacement[] = [];

    constructor(private _broker: Interfaces.IOrderBroker,
        private _exchBroker: Interfaces.IBroker,
        private _side: Models.Side) {
        this._exchange = _exchBroker.exchange();
        this._broker.OrderUpdate.on(this.handleOrderUpdate);
    }

    private handleOrderUpdate = (o: Models.OrderStatusReport) => {
        switch (o.orderStatus) {
            case Models.OrderStatus.Cancelled:
            case Models.OrderStatus.Complete:
            case Models.OrderStatus.Rejected:
                const bySide = this._activeQuote;
                if (bySide !== null && bySide.orderIds.has(o.orderId)) {
                    this._activeQuote.orderIds.delete(o.orderId);
                    if (this._activeQuote.orderIds.size == 0)
                        this._activeQuote = null;
                }

                this.quotesSent = this.quotesSent.filter(q => !q.orderIds.has(o.orderId));  // TODO revist this for limit calc logic
        }
    };

    public updateQuote = (q: Models.Timestamped<Models.Quote>): Models.QuoteSent => {
        if (this._exchBroker.connectStatus !== Models.ConnectivityStatus.Connected)
            return Models.QuoteSent.UnableToSend;

        if (this._activeQuote !== null) {
            return this.modify(q);
        }
        return this.start(q);
    };

    public cancelQuote = (t: Date): Models.QuoteSent => {
        if (this._exchBroker.connectStatus !== Models.ConnectivityStatus.Connected)
            return Models.QuoteSent.UnableToSend;

        return this.stop(t);
    };

    private modify = (q: Models.Timestamped<Models.Quote>): Models.QuoteSent => {
        this.stop(q.time);
        this.start(q);
        return Models.QuoteSent.Modify;
    };

    private start = (q: Models.Timestamped<Models.Quote>): Models.QuoteSent => {
        const existing = this._activeQuote;

        var quoteOrderIds = new Set<string>();

        const tickSize = this._exchBroker.minTickIncrement;
        //TODO this should be per symbol
        const lotSize = this._exchBroker.minLotIncrement ? this._exchBroker.minLotIncrement : 0.01;

        // TODO make this random and configurable
        var maxDepth = 5;
        while (maxDepth) {
            const qty = q.data.size * 0.2;
            const price = q.data.price + tickSize * maxDepth * (this._side == Models.Side.Ask ? 1 : -1);

            const newOrder = new Models.SubmitNewOrder(this._side, qty, Models.OrderType.Limit,
                price, Models.TimeInForce.GTC, this._exchange, q.time, true, Models.OrderSource.Quote);
            const sent = this._broker.sendOrder(newOrder);
            quoteOrderIds.add(sent.sentOrderClientId);

            maxDepth--;
        }

        const quoteOrder = new QuotePlacement(q.data, quoteOrderIds);
        this.quotesSent.push(quoteOrder);
        this._activeQuote = quoteOrder;

        return Models.QuoteSent.First;
    };

    private stop = (t: Date): Models.QuoteSent => {
        if (this._activeQuote === null) {
            return Models.QuoteSent.UnsentDelete;
        }

        for (let oid of this._activeQuote.orderIds) {
            const cxl = new Models.OrderCancel(oid, this._exchange, t);
            this._broker.cancelOrder(cxl);
        }

        this._activeQuote = null;
        return Models.QuoteSent.Delete;
    };
}
