/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { LikeSocket } from 'noice-json-rpc';
import { logger } from 'vscode-debugadapter';

/* Assumptions made to implement this multiplexor:
    1. The message IDs of CRDP don't need to be sent in order
    2. The Domain.enable messages don't have any side-effects (We might send them multiple times)
    3. The clients are ready to recieve domain messages when they send the Domain.enable message (A better design would be to assume that they are ready after we've sent the response for that message, but this approach seems to be working so far)
    4. The clients never disable any Domain
    5. The clients enable all domains in the first 60 seconds after they've connected
 */

function extractDomain(method: string): string {
    const methodParts = method.split(".");
    if (methodParts.length === 2) {
        return methodParts[0];
    } else {
        throwCriticalError(`The method ${method} didn't have exactly two parts`);
        return "Unknown";
    }
}

function encodifyChannel(channelId: number, id: number): number {
    return id * 10 + channelId;
}

function decodifyChannelId(encodifiedId: number): number {
    return encodifiedId % 10;
}
function decodifyId(encodifiedId: number): number {
    return Math.floor(encodifiedId / 10);
}

function throwCriticalError(message: string): void {
    logger.error("CRDP Multiplexor - CRITICAL-ERROR: " + message);
    throw new Error(message);
}

export class CRDPMultiplexor {
    private _channels: CRDPChannel[] = [];

    private onMessage(data: string): void {
        const message = JSON.parse(data);
        if (message.id !== undefined) {
            this.onResponseMessage(message, data);
        } else if (message.method) {
            this.onDomainNotification(message, data);
        } else {
            throwCriticalError(`Message didn't have id nor method: ${data}`);
        }
    }

    private onResponseMessage(message: {id: number}, data: string): void {
        // The message is a response, so it should only go to the channel that requested this
        const channel = this._channels[decodifyChannelId(message.id)];
        if (channel) {
            message.id = decodifyId(message.id);
            data = JSON.stringify(message);
            channel.callMessageCallbacks(data);
        } else {
            throwCriticalError(`Didn't find channel for message with id: ${message.id} and data: <${data}>`);
        }
    }

    private onDomainNotification(message: {method: string}, data: string): void {
        // The message is a notification, so it should go to all channels. The channels itself will filter based on the enabled domains
        const domain = extractDomain(message.method);
        for (const channel of this._channels) {
            channel.callDomainMessageCallbacks(domain, data);
        }
    }

    constructor(private _wrappedLikeSocket: LikeSocket) {
        this._wrappedLikeSocket.on('message', data => this.onMessage(data));
    }

    public addChannel(channelName: string): CRDPChannel {
        if (this._channels.length >= 10) {
            throw new Error(`Only 10 channels are supported`);
        }

        const channel = new CRDPChannel(channelName, this._channels.length, this);
        this._channels.push(channel);
        return channel;
    }

    public send(channel: CRDPChannel, data: string): void {
        const message = JSON.parse(data);
        if (message.id !== undefined) {
            message.id = encodifyChannel(channel.id, message.id);
            data = JSON.stringify(message);
        } else {
            throwCriticalError(`Channel [${channel.name}] sent a message without an id: ${data}`);
        }
        this._wrappedLikeSocket.send(data);
    }

    public addListenerOfNonMultiplexedEvent(event: string, cb: Function): void {
        this._wrappedLikeSocket.on(event, cb);
    }

    public removeListenerOfNonMultiplexedEvent(event: string, cb: Function): void {
        this._wrappedLikeSocket.removeListener(event, cb);
    }
}

export class CRDPChannel implements LikeSocket {
    private static timeToPreserveMessagesInMillis = 60 * 1000;

    private _messageCallbacks: Function[] = [];
    private _enabledDomains: { [domain: string]: boolean } = {};
    private _pendingMessagesForDomain: { [domain: string]: string[] } = {};

    public callMessageCallbacks(messageData: string): void {
        this._messageCallbacks.forEach(callback => callback(messageData));
    }

    public callDomainMessageCallbacks(domain: string, messageData: string): void {
        if (this._enabledDomains[domain]) {
            this.callMessageCallbacks(messageData);
        } else if (this._pendingMessagesForDomain !== null) {
            // We give clients 60 seconds after they connect to the channel to enable domains and receive all messages
            this.storeMessageForLater(domain, messageData);
        }
    }

    private storeMessageForLater(domain: string, messageData: string): void {
        let messagesForDomain = this._pendingMessagesForDomain[domain];
        if (messagesForDomain === undefined) {
            this._pendingMessagesForDomain[domain] = [];
            messagesForDomain = this._pendingMessagesForDomain[domain];
        }

        // Usually this is too much logging, but we might use it while debugging
        // logger.log(`CRDP Multiplexor - Storing message to channel ${this.name} for ${domain} for later: ${messageData}`);
        messagesForDomain.push(messageData);
    }

    constructor(public name: string, public id: number, private _multiplexor: CRDPMultiplexor) { }

    public send(messageData: string): void {
        const message = JSON.parse(messageData);
        const method = message.method;
        const isEnableMethod = method && method.endsWith(".enable");
        let domain;

        if (isEnableMethod) {
            domain = extractDomain(method);
            this._enabledDomains[domain] = true;
        }

        this._multiplexor.send(this, messageData);

        if (isEnableMethod) {
            this.sendUnsentPendingMessages(domain);
        }
    }

    private sendUnsentPendingMessages(domain: string): void {
        const pendingMessagesData = this._pendingMessagesForDomain[domain];
        if (pendingMessagesData !== undefined && this._messageCallbacks.length) {
            logger.log(`CRDP Multiplexor - Sending pending messages of domain ${domain}(Count = ${pendingMessagesData.length})`);
            delete this._pendingMessagesForDomain[domain];
            pendingMessagesData.forEach(pendingMessageData => {
                this.callDomainMessageCallbacks(domain, pendingMessageData);
            });
        }
    }

    private discardUnsentPendingMessages(): void {
        logger.log(`CRDP Multiplexor - Discarding unsent pending messages for domains: ${Object.keys(this._pendingMessagesForDomain).join(", ")}`);
        this._pendingMessagesForDomain = null;
    }

    public on(event: string, cb: Function): void;
    public on(event: "open", cb: (ws: LikeSocket) => void): void;
    public on(event: "message", cb: (data: string) => void): void;
    public on(event: string, cb: Function): void {
        if (event === 'message') {
            if (this._messageCallbacks.length === 0) {
                setTimeout(() => this.discardUnsentPendingMessages(), CRDPChannel.timeToPreserveMessagesInMillis);
            }

            this._messageCallbacks.push(cb);
        } else {
            this._multiplexor.addListenerOfNonMultiplexedEvent(event, cb);
        }
    }

    public removeListener(event: string, cb: Function): void {
        if (event === 'message') {
            const index = this._messageCallbacks.indexOf(cb);
            this._messageCallbacks.splice(index, 1);
        } else {
            this._multiplexor.removeListenerOfNonMultiplexedEvent(event, cb);
        }
    }
}
