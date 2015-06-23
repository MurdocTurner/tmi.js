var bunyan = require("bunyan");
var eventEmitter = require("events").EventEmitter;
var parse = require("irc-message").parse;
var timer = require("./timer");
var server = require("./server");
var util = require("util");
var utils = require("./utils");
var vow = require("vow");
var webSocket = require("ws");

function rawStream() {}

// Custom formatting for logger..
rawStream.prototype.write = function (rec) {
    var message = rec.msg || rec.raw;

    if(typeof message === "object" && message !== null) {
        message = JSON.stringify(message);
    }

    var hours = rec.time.getHours();
    var minutes = rec.time.getMinutes();
    var ampm = hours >= 12 ? "pm" : "am";

    hours = hours % 12;
    hours = hours ? hours : 12;
    hours = hours < 10 ? "0" + hours : hours;
    minutes = minutes < 10 ? "0" + minutes : minutes;

    console.log("[%s] %s: %s", hours + ":" + minutes + ampm, bunyan.nameFromLevel[rec.level], message);
};

// Client instance..
var client = function client(opts) {
    this.setMaxListeners(0);
    
    this.opts = (typeof opts !== "undefined") ? opts : {};
    this.opts.channels = opts.channels || [];
    this.opts.connection = opts.connection || {};
    this.opts.identity = opts.identity || {};
    this.opts.options = opts.options || {};

    this.usingWebSocket = true;
    this.username = "";
    this.userstate = {};
    this.wasCloseCalled = false;
    this.ws = null;

    // Create the logger..
    this.log = bunyan.createLogger({
        name: "tmi.js",
        streams: [
            {
                level: "error",
                stream: new rawStream(),
                type: "raw"
            }
        ]
    });

    // Show debug messages ?
    if (typeof this.opts.options.debug !== "undefined" ? this.opts.options.debug : false) { this.log.level("info"); }

    eventEmitter.call(this);
}

util.inherits(client, eventEmitter);

// Handle parsed message..
client.prototype.handleMessage = function handleMessage(message) {
    var self = this;

    // Parse emotes..
    if (typeof message.tags['emotes'] === 'string') {
        var emoticons = message.tags['emotes'].split('/');
        var emotes = {};

        for (var i = 0; i < emoticons.length; i++) {
            var parts = emoticons[i].split(':');
            emotes[parts[0]] = parts[1].split(',');
        }
        message.tags['emotes'] = emotes;
    } else { message.tags['emotes'] = null; }
    
    // Transform the IRCv3 tags..
    if (message.tags) {
        for(var key in message.tags) {
           if (typeof message.tags[key] === "boolean") { message.tags[key] = null; }
           else if (message.tags[key] === "1") { message.tags[key] = true; }
           else if (message.tags[key] === "0") { message.tags[key] = false; }
        }
    }
    
    // Messages with no prefix..
    if (message.prefix === null) {
        switch(message.command) {
            // Received PING from server..
            case "PING":
                self.emit("ping");
                self.ws.send("PONG");
                break;

            // Received PONG from server, return current latency
            case "PONG":
                self.emit("pong");
                break;

            default:
                self.log.warn("Could not parse message with no prefix:");
                self.log.warn(message);
                break;
        }
    }

    // Messages with "tmi.twitch.tv" as a prefix..
    else if (message.prefix === "tmi.twitch.tv") {
        switch(message.command) {
            case "002":
            case "003":
            case "004":
            case "375":
            case "376":
            case "CAP":
                break;

            // Got username from server..
            case "001":
                self.username = message.params[0];
                break;

            // Connected to server..
            case "372":
                self.log.info("Connected to server.");
                self.emit("connected", self.server, self.port);

                self.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");

                // Join all the channels from configuration every 2 seconds..
                var joinQueue = new timer.queue(2000);

                for (var i = 0; i < self.opts.channels.length; i++) {
                    joinQueue.add(function(i) {
                        if (self.usingWebSocket && self.ws !== null && self.ws.readyState !== 2 && self.ws.readyState !== 3) {
                            self.ws.send("JOIN " + utils.normalizeChannel(self.opts.channels[i]));
                        }
                    }.bind(this, i))
                }

                joinQueue.run();
                break;

            // https://github.com/justintv/Twitch-API/blob/master/chat/capabilities.md#notice
            case "NOTICE":
                var msgid = message.tags["msg-id"] || null;

                switch(msgid) {
                    // This room is now in subscribers-only mode.
                    case "subs_on":
                        self.log.info("[" + message.params[0] + "] This room is now in subscribers-only mode.");
                        self.emit("subscriber", message.params[0], true);
                        self.emit("subscribers", message.params[0], true);
                        break;

                    // This room is no longer in subscribers-only mode.
                    case "subs_off":
                        self.log.info("[" + message.params[0] + "] This room is no longer in subscribers-only mode.");
                        self.emit("subscriber", message.params[0], false);
                        self.emit("subscribers", message.params[0], false);
                        break;

                    // This room is now in slow mode. You may send messages every slow_duration seconds.
                    case "slow_on":
                        // TODO: Display seconds..
                        self.log.info("[" + message.params[0] + "] This room is now in slow mode.");
                        self.emit("slow", message.params[0], true);
                        self.emit("slowmode", message.params[0], true);
                        break;

                    // This room is no longer in slow mode.
                    case "slow_off":
                        self.log.info("[" + message.params[0] + "] This room is no longer in slow mode.");
                        self.emit("slow", message.params[0], false);
                        self.emit("slowmode", message.params[0], false);
                        break;

                    // This room is now in r9k mode.
                    case "r9k_on":
                        self.log.info("[" + message.params[0] + "] This room is now in r9k mode.");
                        self.emit("r9kmode", message.params[0], true);
                        break;

                    // This room is no longer in r9k mode.
                    case "r9k_off":
                        self.log.info("[" + message.params[0] + "] This room is no longer in r9k mode.");
                        self.emit("r9kmode", message.params[0], false);
                        self.emit("r9kbeta", message.params[0], false);
                        break;

                    // Ignore this because we are already listening to HOSTTARGET.
                    case "host_on":
                    case "host_off":
                        //
                        break;
                }

                if (message.params[1].indexOf("Login unsuccessful") >= 0) {
                    self.wasCloseCalled = true;
                    self.log.error("Login unsuccessful.");
                    self.ws.close();
                }
                break;

            // Channel is now hosting another channel or exited host mode..
            case "HOSTTARGET":
                // Stopped hosting..
                if (message.params[1].split(" ")[0] === "-") {
                    self.log.info("[" + message.params[0] + "] Exited host mode.");
                    self.emit("unhost", message.params[0], message.params[1].split(" ")[0]);
                }
                // Now hosting..
                else {
                    var viewers = message.params[1].split(" ")[1] || 0;
                    if (!utils.isInteger(viewers)) { viewers = 0; }
                    
                    self.log.info("[" + message.params[0] + "] Now hosting " + message.params[1].split(" ")[0] + " for " + viewers + " viewer(s).");
                    self.emit("hosting", message.params[0], message.params[1].split(" ")[0], viewers);
                }
                break;

            // Someone has been timed out or chat has been cleared by a moderator..
            case "CLEARCHAT":
                // User has been timed out by a moderator..
                if (message.params.length > 1) {
                    self.log.info("[" + message.params[0] + "] " + message.params[1] + " has been timed out.");
                    self.emit("timeout", message.params[0], message.params[1]);
                }
                // Chat was cleared by a moderator..
                else {
                    self.log.info("[" + message.params[0] + "] Chat was cleared by a moderator.");
                    self.emit("clearchat", message.params[0]);
                }
                break;

            case "RECONNECT":
                self.log.info("Received RECONNECT request from Twitch..");
                self.log.info("Disconnecting and reconnecting in 10 seconds..");
                self.disconnect();
                setTimeout(function() { self.connect(); }, 10000);
                break;

            // Received when joining a channel and every time you send a PRIVMSG to a channel.
            case "USERSTATE":
                message.tags.username = self.username;
                self.userstate[message.params[0]] = message.tags;
                break;
                
            // Will be used in the future to describe non-channel-specific state information.
            // Source: https://github.com/justintv/Twitch-API/blob/master/chat/capabilities.md#globaluserstate
            case "GLOBALUSERSTATE":
                self.log.warn("Could not parse message from tmi.twitch.tv:");
                self.log.warn(message);
                break;
                
            case "ROOMSTATE":
                self.emit("roomstate", message.params[0], message.tags);
                break;

            default:
                self.log.warn("Could not parse message from tmi.twitch.tv:");
                self.log.warn(message);
                break;
        }
    }

    // Messages from jtv..
    else if (message.prefix === "jtv") {
        switch(message.command) {
            case "MODE":
                if (message.params[1] === "+o") {
                    self.emit("mod", message.params[0], message.params[2]);
                }
                else if (message.params[1] === "-o") {
                    self.emit("unmod", message.params[0], message.params[2]);
                }
                break;

            default:
                self.log.warn("Could not parse message from jtv:");
                self.log.warn(message);
                break;
        }
    }

    // Anything else..
    else {
        switch(message.command) {
            case "353":
                self.emit("names", message.params[2], message.params[3].split(" "));
                break;

            case "366":
                break;

            case "JOIN":
                if (self.username === message.prefix.split("!")[0]) {
                    self.log.info("Joined " + message.params[0]);
                }
                self.emit("join", message.params[0], message.prefix.split("!")[0]);
                break;

            case "PART":
                if (self.username === message.prefix.split("!")[0]) {
                    self.log.info("Left " + message.params[0]);
                }
                self.emit("part", message.params[0], message.prefix.split("!")[0]);
                break;

            case "PRIVMSG":
                // Add username (lowercase) to the tags..
                message.tags.username = message.prefix.split("!")[0];

                // Message is an action..
                if (message.params[1].match(/^\u0001ACTION ([^\u0001]+)\u0001$/)) {
                    self.log.info("[" + message.params[0] + "] *<" + message.tags.username + ">: " + message.params[1].match(/^\u0001ACTION ([^\u0001]+)\u0001$/)[1]);
                    self.emit("action", message.params[0], message.tags, message.params[1].match(/^\u0001ACTION ([^\u0001]+)\u0001$/)[1]);
                }
                // Message is a regular message..
                else {
                    self.log.info("[" + message.params[0] + "] <" + message.tags.username + ">: " + message.params[1]);
                    self.emit("chat", message.params[0], message.tags, message.params[1]);
                }
                
                if (message.tags.username === "twitchnotify") {
                    // Someone subscribed to a hosted channel. Who cares.
                    if (message.params[1].indexOf("subscribed to") >= 0) {
                        //
                    }
                    // New subscriber..
                    else if (message.params[1].indexOf("just subscribed") >= 0) {
                        self.emit('subscription', message.params[0], message.params[1].split(' ')[0]);
                    }
                    // Subanniversary..
                    else if (message.params[1].indexOf("subscribed") >= 0 && message.params[1].indexOf("in a row") >= 0) {
                        var splitted = message.params[1].split(' ');
                        var length = splitted[splitted.length - 5];
                        
                        self.emit('subanniversary', message.params[0], splitted[0], length);
                    }
                }
                
                else if (message.tags.username === "jtv") {
                    // Client sent /mods command to channel..
                    if (message.params[1].indexOf("moderators of this room are") >= 0) {
                        var splitted = message.params[1].split(':');
                        var mods = splitted[1].replace(/,/g, '').split(':').toString().toLowerCase().split(' ');

                        for(var i = mods.length - 1; i >= 0; i--) {
                            if(mods[i] === '') {
                                mods.splice(i, 1);
                            }
                        }
                        
                        self.emit('mods', message.params[0], mods);
                        self.emit('modspromises', message.params[0], mods);
                    }
                    // Someone is hosting my channel..
                    else if (message.params[1].indexOf("is now hosting you") >= 0) {
                        self.emit('hosted', message.params[0], utils.normalizeUsername(message.params[1].split(' ')[0]));
                    }
                }
                break;

            default:
                self.log.warn("Could not parse message:");
                self.log.warn(message);
                break;
        }
    }
};

// Connect to server..
client.prototype.connect = function connect(ignoreServer) {
    var self = this;
    var deferred = vow.defer();
    
    this.reconnect = typeof this.opts.connection.reconnect !== "undefined" ? this.opts.connection.reconnect : false;
    this.server = typeof this.opts.connection.server !== "undefined" ? this.opts.connection.server : "RANDOM";
    this.port = typeof this.opts.connection.port !== "undefined" ? this.opts.connection.port : 443;

    // Connect to a random server..
    if (this.server === "RANDOM" || typeof this.opts.connection.random !== "undefined") {
        ignoreServer = typeof ignoreServer !== "undefined" ? ignoreServer : null;

        // Default type is "chat" server..
        server.getRandomServer(typeof self.opts.connection.random !== "undefined" ? self.opts.connection.random : "chat", ignoreServer, function (addr) {
            self.server = addr.split(":")[0];
            self.port = addr.split(":")[1];

            self._openConnection();
            deferred.resolve();
        });
    }
    // Connect to server from configuration..
    else {
        this._openConnection();
        deferred.resolve();
    }
    
    return deferred.promise();
};

// Open a connection..
client.prototype._openConnection = function _openConnection() {
    var self = this;

    server.isWebSocket(self.server, self.port, function(accepts) {
        // Server is accepting WebSocket connections..
        if (accepts) {
            self.usingWebSocket = true;
            self.ws = new webSocket("ws://" + self.server + ":" + self.port + "/", "irc");

            self.ws.onmessage = self._onMessage.bind(self);
            self.ws.onerror = self._onError.bind(self);
            self.ws.onclose = self._onClose.bind(self);
            self.ws.onopen = self._onOpen.bind(self);
        }
        // Server is not accepting WebSocket connections..
        else {
            if (self.reconnect) {
                self.log.error("Server is not accepting WebSocket connections. Reconnecting in 10 seconds..");
                self.emit("reconnect");
                setTimeout(function() { self.connect(self.server + ":" + self.port); }, 10000);
            } else {
                self.log.error("Server is not accepting WebSocket connections.");
            }
        }
    });
};

// Called when the WebSocket connection's readyState changes to OPEN.
// Indicates that the connection is ready to send and receive data..
client.prototype._onOpen = function _onOpen() {
    // Emitting "connecting" event..
    this.log.info("Connecting to %s on port %s..", this.server, this.port);
    this.emit("connecting", this.server, this.port);

    this.username = typeof this.opts.identity.username !== "undefined" ? this.opts.identity.username : utils.generateJustinfan();
    this.password = typeof this.opts.identity.password !== "undefined" ? this.opts.identity.password : "SCHMOOPIIE";

    // Make sure "oauth:" is included..
    if (this.password !== "SCHMOOPIIE" && this.password.indexOf("oauth:") < 0) {
        this.password = "oauth:" + this.password;
    }

    // Emitting "logon" event..
    this.log.info("Sending authentication to server..");
    this.emit("logon");

    // Authentication..
    this.ws.send("PASS " + this.password);
    this.ws.send("NICK " + this.username);
    this.ws.send("USER " + this.username + " 8 * :" + this.username);
};

// Called when a message is received from the server..
client.prototype._onMessage = function _onMessage(event) {
    this.handleMessage(parse(event.data.replace("\r\n", "")));
};

// Called when an error occurs..
client.prototype._onError = function _onError() {
    if (this.ws !== null) {
        this.log.error("Unable to connect.");
        this.emit("disconnected", "Unable to connect.");
    } else {
        this.log.error("Connection closed.");
        this.emit("disconnected", "Connection closed.");
    }
};

// Called when the WebSocket connection's readyState changes to CLOSED..
client.prototype._onClose = function _onClose() {
    var self = this;
    
    // User called .disconnect();
    if (this.wasCloseCalled) {
        this.wasCloseCalled = false;
        this.log.info("Connection closed.");
        this.emit("disconnected", "Connection closed.");
    }
    // Got disconnected from server..
    else {
        this.emit("disconnected", "Unable to connect to chat.");

        if (this.reconnect) {
            this.log.error("Sorry, we were unable to connect to chat. Reconnecting in 10 seconds..");
            this.emit("reconnect");
            setTimeout(function() { self.connect(self.server + ":" + self.port); }, 10000);
        } else {
            this.log.error("Sorry, we were unable to connect to chat.");
        }
    }
};

// Send a command to the server..
client.prototype._sendCommand = function _sendCommand(channel, command) {
    var self = this;
    
    // Promise a result..
    return new vow.Promise(function(resolve, reject, notify) {
        if (self.usingWebSocket && self.ws !== null && self.ws.readyState !== 2 && self.ws.readyState !== 3 && self.getUsername().indexOf("justinfan") < 0) {
            switch (command.toLowerCase()) {
                case "/mods":
                case ".mods":
                    self.log.info("Executing command: " + command);
                    self.once("modspromises", function (channel, mods) {
                        resolve(mods);
                    });
                    self.ws.send("PRIVMSG " + utils.normalizeChannel(channel) + " :" + command);
                    break;
                default:
                    if (channel !== null) {
                        self.log.info("[" + utils.normalizeChannel(channel) + "] Executing command: " + command);
                        self.ws.send("PRIVMSG " + utils.normalizeChannel(channel) + " :" + command);
                    } else {
                        self.log.info("Executing command: " + command);
                        self.ws.send(command);
                    }
                    resolve();
                    break;
            }
        } else {
            reject();
        }
    });
}

// Send a message to the server..
client.prototype._sendMessage = function _sendMessage(channel, message) {
    var self = this;
    
    // Promise a result..
    return new vow.Promise(function(resolve, reject, notify) {
        if (self.usingWebSocket && self.ws !== null && self.ws.readyState !== 2 && self.ws.readyState !== 3 && self.getUsername().indexOf("justinfan") < 0) {
            self.ws.send("PRIVMSG " + utils.normalizeChannel(channel) + " :" + message);
            
            if (message.match(/^\u0001ACTION ([^\u0001]+)\u0001$/)) {
                self.log.info("[" + utils.normalizeChannel(channel) + "] *<" + self.getUsername() + ">: " + message.match(/^\u0001ACTION ([^\u0001]+)\u0001$/)[1]);
                self.emit("action", utils.normalizeChannel(channel), self.userstate[utils.normalizeChannel(channel)], message.match(/^\u0001ACTION ([^\u0001]+)\u0001$/)[1]);
            } else {
                self.log.info("[" + utils.normalizeChannel(channel) + "] <" + self.getUsername() + ">: " + message);
                self.emit("chat", utils.normalizeChannel(channel), self.userstate[utils.normalizeChannel(channel)], message);
            }
            resolve();
        } else {
            reject();
        }
    });
}

// Get current username..
client.prototype.getUsername = function getUsername() {
    return this.username;
};

// Get current options..
client.prototype.getOptions = function getOptions() {
    return this.opts;
};

// Disconnect from server..
client.prototype.disconnect = function disconnect() {
    var deferred = vow.defer();
    
    if (this.usingWebSocket && this.ws !== null && this.ws.readyState !== 3) {
        this.wasCloseCalled = true;
        this.log.info("Disconnecting from server..");
        this.ws.close();
        deferred.resolve();
    } else {
        this.log.error("Cannot disconnect from server. Socket is not opened or connection is already closing.");
        deferred.reject();
    }
    
    return deferred.promise();
};

client.prototype.action = function action(channel, message) {
    message = "\u0001ACTION " + message + "\u0001";
    return this._sendMessage(channel, message);
};

client.prototype.ban = function ban(channel, username) {
    return this._sendCommand(channel, "/ban " + utils.normalizeUsername(username));
};

client.prototype.clear = function clear(channel) {
    return this._sendCommand(channel, "/clear");
};

client.prototype.color = function color(channel, color) {
    return this._sendCommand(channel, "/color " + color);
};

client.prototype.commercial = function commercial(channel, seconds) {
    seconds = typeof seconds !== 'undefined' ? seconds : 30;
    return this._sendCommand(channel, "/commercial " + seconds);
};

client.prototype.host = function host(channel, target) {
    return this._sendCommand(channel, "/host " + utils.normalizeUsername(target));
};

client.prototype.join = function join(channel) {
    return this._sendCommand(null, "JOIN " + utils.normalizeChannel(channel));
};

client.prototype.mod = function mod(channel, username) {
    return this._sendCommand(channel, "/mod " + utils.normalizeUsername(username));
};

client.prototype.mods = function mods(channel) {
    return this._sendCommand(channel, "/mods");
};

client.prototype.part = client.prototype.leave = function part(channel) {
    return this._sendCommand(null, "PART " + utils.normalizeChannel(channel));
};

client.prototype.ping = function ping() {
    return this._sendCommand(null, "PING");
};

client.prototype.r9kbeta = client.prototype.r9kmode = function r9kbeta(channel) {
    return this._sendCommand(channel, "/r9kbeta");
};

client.prototype.r9kbetaoff = client.prototype.r9kmodeoff = function r9kbetaoff(channel) {
    return this._sendCommand(channel, "/r9kbetaoff");
};

client.prototype.raw = function raw(message) {
    return this._sendCommand(null, message);
};

client.prototype.say = function say(channel, message) {
    return this._sendMessage(channel, message);
};

client.prototype.slow = client.prototype.slowmode = function slow(channel, seconds) {
    seconds = typeof seconds !== 'undefined' ? seconds : 300;
    
    return this._sendCommand(channel, "/seconds " + seconds);
};

client.prototype.slowoff = client.prototype.slowmodeoff = function slowoff(channel) {
    return this._sendCommand(channel, "/slowoff");
};

client.prototype.subscribers = function subscribers(channel) {
    return this._sendCommand(channel, "/subscribers");
};

client.prototype.subscribersoff = function subscribersoff(channel) {
    return this._sendCommand(channel, "/subscribersoff");
};

client.prototype.timeout = function timeout(channel, username, seconds) {
    seconds = typeof seconds !== 'undefined' ? seconds : 300;
    username = typeof username !== 'undefined' ? username : "Kappa";
    
    return this._sendCommand(channel, "/timeout " + username + " " + seconds);
};

client.prototype.unban = function unban(channel, username) {
    return this._sendCommand(channel, "/unban " + utils.normalizeUsername(username));
};

client.prototype.unhost = function unhost(channel) {
    return this._sendCommand(channel, "/unhost");
};

client.prototype.unmod = function unmod(channel, username) {
    return this._sendCommand(channel, "/unmod " + utils.normalizeUsername(username));
};

// Expose everything, for browser and Node.js / io.js
if (typeof window !== "undefined") {
    window.irc = {};
    window.irc.client = client;
} else {
    module.exports = client;
}