/// <reference path="../common/models.ts" />
/// <reference path="../common/messaging.ts" />
/// <reference path="shared_directives.ts"/>

import angular = require("angular");
import Models = require("../common/models");
import io = require("socket.io-client");
import moment = require("moment");
import Messaging = require("../common/messaging");
import Shared = require("./shared_directives");

class FvRefLevel {
    bidPrice: string;
    bidSize: number;
    askPrice: string;
    askSize: number;

    exchange: string;
}

interface MarketFvReferenceScope extends ng.IScope {
    fvRefLevels: FvRefLevel[];
    fairValue: string;
}

var MarketFvReferenceController = ($scope: MarketFvReferenceScope,
        $log: ng.ILogService,
        subscriberFactory: Shared.SubscriberFactory,
        product: Shared.ProductState) => {

    var toPrice = (px: number) : string => px.toFixed(product.fixed);
    var toPercent = (askPx: number, bidPx: number): string => ((askPx - bidPx) / askPx * 100).toFixed(2);

    var clearMarket = () => {
        $scope.fvRefLevels = [];
    };
    clearMarket();

    var clearFairValue = () => {
        $scope.fairValue = null;
    };

    var updateMarket = (update: Models.Market) => {
        if (update == null) {
            clearMarket();
            return;
        }

        for (var i = 0; i < update.asks.length; i++) {
            if (angular.isUndefined($scope.fvRefLevels[i]))
                $scope.fvRefLevels[i] = new FvRefLevel();
            $scope.fvRefLevels[i].askPrice = toPrice(update.asks[i].price);
            $scope.fvRefLevels[i].askSize = update.asks[i].size;
            if (!update.asks[i].exchange)
                $scope.fvRefLevels[i].exchange = '';
            else
                $scope.fvRefLevels[i].exchange = Models.Exchange[update.asks[i].exchange];
        }

        for (var i = 0; i < update.bids.length; i++) {
            if (angular.isUndefined($scope.fvRefLevels[i]))
                $scope.fvRefLevels[i] = new FvRefLevel();
            $scope.fvRefLevels[i].bidPrice = toPrice(update.bids[i].price);
            $scope.fvRefLevels[i].bidSize = update.bids[i].size;
            if (!update.bids[i].exchange)
                $scope.fvRefLevels[i].exchange = '';
            else
                $scope.fvRefLevels[i].exchange = Models.Exchange[update.bids[i].exchange];
        }
    };

    var updateFairValue = (fv: Models.FairValue) => {
        if (fv == null) {
            clearFairValue();
            return;
        }

        $scope.fairValue = toPrice(fv.price);
    };

    var subscribers = [];

    var makeSubscriber = <T>(topic: string, updateFn, clearFn) => {
        var sub = subscriberFactory.getSubscriber<T>($scope, topic)
            .registerSubscriber(updateFn, ms => ms.forEach(updateFn))
            .registerConnectHandler(clearFn);
        subscribers.push(sub);
    };

    makeSubscriber<Models.Market>(Messaging.Topics.FairValueMarketData, updateMarket, clearMarket);
    makeSubscriber<Models.FairValue>(Messaging.Topics.FairValue, updateFairValue, clearFairValue);

    $scope.$on('$destroy', () => {
        subscribers.forEach(d => d.disconnect());
        $log.info("destroy market fv reference grid");
    });

    $log.info("started market fv reference grid");
};

export var marketFvReferenceDirective = "marketFvReferenceDirective";

angular
    .module(marketFvReferenceDirective, ['ui.bootstrap', 'ui.grid', Shared.sharedDirectives])
    .directive("marketFvReferenceGrid", () => {

        return {
            restrict: 'E',
            replace: true,
            transclude: false,
            templateUrl: "market_fv_reference.html",
            controller: MarketFvReferenceController
        }
    });
