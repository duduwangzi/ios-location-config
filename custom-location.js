(function () {
  "use strict";

  var args = {};
  if (typeof $argument === 'string') {
    $argument.split('&').forEach(function(p) {
      var pair = p.split('=');
      args[pair[0]] = pair[1];
    });
  }

  var cfg = {
    lat: Math.trunc(Number(args.latitude ?? 37.3349) * 1e8),
    lon: Math.trunc(Number(args.longitude ?? -122.009) * 1e8),
    hAcc: Math.trunc(Number(args.horizontalAccuracy ?? 39)),
    vAcc: Math.trunc(Number(args.verticalAccuracy ?? 30)),
    alt: Math.trunc(Number(args.altitude ?? 12)),
    u4: Math.trunc(Number(args.unknownValue4 ?? 3)),
    mType: Math.trunc(Number(args.motionActivityType ?? 63)),
    mConf: Math.trunc(Number(args.motionActivityConfidence ?? 467))
  };

  var rawBody = $response ? ($response.bodyBytes || $response.body) : null;
  if (!rawBody) return $done({});

  var body;
  if (rawBody instanceof Uint8Array) {
    body = rawBody;
  } else if (rawBody instanceof ArrayBuffer) {
    body = new Uint8Array(rawBody);
  } else {
    body = new Uint8Array([].map.call(rawBody, function (c) { return c.charCodeAt(0) & 0xff; }));
  }

  function readU16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function writeU16(v) { return new Uint8Array([(v >> 8) & 0xff, v & 0xff]); }
  function writeU32(v) { return new Uint8Array([(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]); }
  function concat(arrs) {
    var total = arrs.reduce(function (a, b) { return a + b.length; }, 0);
    var r = new Uint8Array(total), o = 0;
    arrs.forEach(function (a) { r.set(a, o); o += a.length; });
    return r;
  }

  function encVar(v) {
    var n = BigInt.asUintN(64, BigInt(v)), r = [];
    while (n >= 0x80n) { r.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
    r.push(Number(n));
    return new Uint8Array(r);
  }

  function decVar(b, o) {
    var r = 0n, s = 0n;
    while (o < b.length) {
      var byte = b[o++];
      r |= BigInt(byte & 0x7f) << s;
      if (!(byte & 0x80)) return { val: r, idx: o };
      s += 7n;
    }
    return { val: r, idx: o };
  }

  function makeF(n, wt, p) {
    var key = encVar((BigInt(n) << 3n) | BigInt(wt));
    if (wt === 0) return concat([key, encVar(p)]);
    if (wt === 2) return concat([key, encVar(p.length), p]);
    return key;
  }

  function parseF(b) {
    var res = [], o = 0;
    while (o < b.length) {
      var kStart = o, k = decVar(b, o); o = k.idx;
      var n = Number(k.val >> 3n), wt = Number(k.val & 7n);
      var vStart = o, vEnd = o;
      if (wt === 0) vEnd = decVar(b, o).idx;
      else if (wt === 1) vEnd = o + 8;
      else if (wt === 5) vEnd = o + 4;
      else if (wt === 2) { var len = decVar(b, o); vStart = len.idx; vEnd = vStart + Number(len.val); }
      res.push({ n: n, wt: wt, raw: b.slice(kStart, vEnd), val: b.slice(vStart, vEnd) });
      o = vEnd;
    }
    return res;
  }

  function patchLoc(pl) {
    var retained = parseF(pl).filter(function (f) {
      return ![1, 2, 3, 4, 5, 6, 11, 12].includes(f.n);
    }).map(function (f) { return f.raw; });
    
    return concat(retained.concat([
      makeF(1, 0, cfg.lat), makeF(2, 0, cfg.lon), makeF(3, 0, cfg.hAcc),
      makeF(4, 0, cfg.u4), makeF(5, 0, cfg.alt), makeF(6, 0, cfg.vAcc),
      makeF(11, 0, cfg.mType), makeF(12, 0, cfg.mConf)
    ]));
  }

  var patchW = function(wl) { return concat(parseF(wl).map(function(f) { return f.n === 2 && f.wt === 2 ? makeF(2, 2, patchLoc(f.val)) : f.raw; })); };
  var patchC = function(cl) { return concat(parseF(cl).map(function(f) { return f.n === 5 && f.wt === 2 ? makeF(5, 2, patchLoc(f.val)) : f.raw; })); };
  
  function patchPayload(pl) {
    return concat(parseF(pl).map(function (f) {
      if (f.n === 2 && f.wt === 2) return makeF(2, 2, patchW(f.val));
      if ((f.n === 22 || f.n === 24) && f.wt === 2) return makeF(f.n, 2, patchC(f.val));
      return f.raw;
    }));
  }

  function process() {
    try {
      var s = { o: 2 };
      var readP = function () {
        var len = readU16(body, s.o); s.o += 2;
        var str = String.fromCharCode.apply(null, body.slice(s.o, s.o + len)); s.o += len;
        return str;
      };
      var writeP = function (str) {
        return concat([writeU16(str.length), new Uint8Array([].map.call(str, function (c) { return c.charCodeAt(0); }))]);
      };
      var loc = readP(), app = readP(), os = readP();
      var fid = readU32(body, s.o); s.o += 4;
      var len = readU32(body, s.o); s.o += 4;
      var patched = patchPayload(body.slice(s.o, s.o + len));
      return concat([writeU16(readU16(body, 0)), writeP(loc), writeP(app), writeP(os), writeU32(fid), writeU32(patched.length), patched]);
    } catch (e) {}

    if (body[0] === 0 && body[1] === 1 && body.length > 10) {
      var len = readU16(body, 8);
      if (10 + len <= body.length) {
        var patched = patchPayload(body.slice(10, 10 + len));
        return concat([body.slice(0, 8), writeU16(patched.length), patched, body.slice(10 + len)]);
      }
    }
    return patchPayload(body);
  }

  var out = process();
  
  $done({
    headers: Object.assign({}, $response ? $response.headers : {}, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(out.length)
    }),
    body: out
  });
})();
