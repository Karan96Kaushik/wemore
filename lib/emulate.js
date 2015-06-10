
var util = require('util')
  , events = require('events')
  , http = require('http')
  , ip = require('ip')
  , uuid = require('uuid')
  , xmlbuilder = require('xmlbuilder')
  , _ = require('lodash')
  , SsdpServer = require('node-ssdp').Server

  , BELKIN_CONTROLLEE = "urn:Belkin:device:controllee:1"
  , BELKIN_BASICEVENT = "urn:Belkin:service:basicevent:1"
  , SETUP_XMLNS = 'urn:Belkin:device-1-0'
  , SETUP_TYPE = BELKIN_CONTROLLEE
  
    // NB: xml2js.Builder has a bug where attrs aren't
    //  handled correctly, so we use its dependency directly
  , XML = function(obj) {
        return xmlbuilder.create(obj).end();
    }
  , SERVER = new SsdpServer({
        logLevel: "WARN"
    });

SERVER.__started = false;
SERVER._nested = [];
var __getSSDPHeader = SsdpServer.prototype._getSSDPHeader;
SsdpServer.prototype._getSSDPHeader = function(method, headers, isResponse) {
    var server = SERVER._nested.filter(function(nested) {
        return nested._location == headers.LOCATION;
    })

    // not all requests will pass location; those that don't
    //  do not need our extra headers
    var uuid = server.length ? server[0].__device.uuid : undefined;

    return __getSSDPHeader.call(this, 
            method, _.extend(headers, {
        OPT: '"http://schemas.upnp.org/upnp/1/0/"; ns=01'
      , '01-NLS': uuid
      , 'X-User-Agent': 'redsonic'
      , SERVER: 'Unspecified, UPnP/1.0, Unspecified'
    }), isResponse);
}

SERVER._respondToSearch = function(serviceType, rinfo) {
    console.log("SEARCH!", serviceType, SERVER._nested.length);
    if (/Belkin:device:\**$/.test(serviceType)) {
        // TODO contribute this upstream
        // we *should* do a proper match, with just the */**,
        //  but right now we are a very specific use case
        serviceType = 'ssdp:all';
    }
    SERVER._nested.forEach(function(nested) {
        nested._respondToSearch(serviceType, rinfo);
    });
}
SERVER.advertise = function(alive) {
    // console.log("ADVERTISE!", SERVER._nested.length);
    SERVER._nested.forEach(function(nested) {
        nested.advertise(alive);
    });
}
SERVER.add = function(child) {
    // console.log("ADD!");
    SERVER._nested.push(child);
}
  
function EmulatedDevice(opts) {

    if (!opts.friendlyName) throw new Error("friendlyName is required");
    if (!opts.uuid) opts.uuid = uuid.v4();
    if (!opts.port) opts.port = 0; // will assign a random port

    this.binaryState = opts.binaryState || 0;

    this.friendlyName = opts.friendlyName;
    this.uuid = opts.uuid;
    this.host = ip.address();

    var self = this;
    this.http = http.createServer(this._onHttpRequest.bind(this));
    this.http.listen(opts.port, function() {
        self.port = self.http.address().port;
        self._initSsdp();
    });
}
util.inherits(EmulatedDevice, events.EventEmitter);

EmulatedDevice.prototype.close = function() {
    this.http.close();
}

EmulatedDevice.prototype._initSsdp = function() {
    var self = this;
    console.log("init ssdp", this.friendlyName, this.port);

    this.ssdp = new SsdpServer({
        logLevel: 'TRACE'
      , location: 'http://' + self.host + ':' + self.port + '/setup.xml'
        // My WeMo Switch looks like this, and will
        //  ping our "device" if we use this format, 
        //  for some reason. Echo and WeMo app still
        //  ignore it, though....
      // , udn: 'uuid:Socket-1_0-123456K0101C68'
      , ttl: 86400
    }, SERVER.sock);
    this.ssdp.addUSN(BELKIN_CONTROLLEE);
    this.ssdp.addUSN(BELKIN_BASICEVENT);
    this.ssdp.__device = this;
    SERVER.add(this.ssdp);
    process.on('exit', this.close.bind(this));
    this.emit('listening', this);
}

EmulatedDevice.prototype._onHttpRequest = function(req, res) {

    console.log(req.connection.remoteAddress, req.headers);

    var handler = this._endpoints[req.url];
    if (!handler) {
        console.log('404', this.friendlyName, "<<", req.method, req.url);
        res.writeHead(404);
        res.end();
        return;
    }

    console.log(this.friendlyName, "<<", req.method, req.url);

    handler.call(this, req, res);
}

EmulatedDevice.prototype._endpoints = {
    '/setup.xml': function(req, res) {
        res.writeHead(200);

        var xml = XML({
            root: {
                '@xmlns': SETUP_XMLNS
              , specVersion: {
                    major: 1
                  , minor: 0
                }
              , device: {
                    deviceType: SETUP_TYPE
                  , friendlyName: this.friendlyName
                  , binaryState: this.binaryState
                  , serviceList: [
                        {service: {
                            serviceType: 'urn:Belkin:service:basicevent:1'
                          , serviceId: 'urn:Belkin:serviceId:basicevent1'
                          , controlURL: '/upnp/control/basicevent1'
                          , eventSubURL: '/upnp/event/basicevent1'
                          , SCPDURL: '/eventservice.xml'
                        }}
                    ]
                }
            }
        });

        // console.log(xml);
        res.write(xml);

        res.end();
    }
  , '/upnp/control/basicevent1': function(req, res) {
        
        console.log("UPNP control!");
        res.writeHead(204);
        res.end();
    }
}

module.exports = function Emulate(opts) {
    var device = new EmulatedDevice(opts);

    if (!SERVER.__started) {
        SERVER.__started = true;
        console.log("Starting...");
        var serverStarter;
        serverStarter = function() {
            device.removeListener('listening', serverStarter);
            SERVER.start();
            process.on('exit', function() {
                SERVER.stop();
            });
        };
        device.on('listening', serverStarter);
    }
    return device;
}

 
