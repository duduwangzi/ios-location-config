(() => {
  const rawBody = $response ? ($response.bodyBytes || $response.body) : null;
  if (!rawBody) return $done({});

  const args = {};
  if (typeof $argument === 'string') $argument.split('&').forEach(p => { const [k, v] = p.split('='); args[k] = v; });
  const cfg = {
    lat: Math.trunc(Number(args.latitude ?? 37.3349) * 1e8),
    lon: Math.trunc(Number(args.longitude ?? -122.009) * 1e8),
    hAcc: Math.trunc(Number(args.horizontalAccuracy ?? 39)),
    vAcc: Math.trunc(Number(args.verticalAccuracy ?? 30)),
    alt: Math.trunc(Number(args.altitude ?? 12)),
    u4: Math.trunc(Number(args.unknownValue4 ?? 3)),
    mType: Math.trunc(Number(args.motionActivityType ?? 63)),
    mConf: Math.trunc(Number(args.motionActivityConfidence ?? 467))
  };

  const body = rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody instanceof ArrayBuffer ? rawBody : [...String(rawBody)].map(c => c.charCodeAt(0) & 0xff));
  const readU16 = (b, o) => (b[o] << 8) | b[o+1], readU32 = (b, o) => ((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0;
  const writeU16 = v => new Uint8Array([(v >> 8) & 0xff, v & 0xff]), writeU32 = v => new Uint8Array([(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const concat = arrs => { const r = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0)); let o = 0; for (const a of arrs) { r.set(a, o); o += a.length; } return r; };
  
  const encVar = v => { let n = BigInt.asUintN(64, BigInt(v)), r = []; while (n >= 0x80n) { r.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; } r.push(Number(n)); return new Uint8Array(r); };
  const decVar = (b, o) => { let r = 0n, s = 0n; while (o < b.length) { const byte = b[o++]; r |= BigInt(byte & 0x7f) << s; if (!(byte & 0x80)) return { val: r, idx: o }; s += 7n; } return { val: r, idx: o }; };
  const makeF = (n, wt, p) => concat([encVar((BigInt(n) << 3n) | BigInt(wt)), wt === 0 ? encVar(p) : wt === 2 ? concat([encVar(p.length), p]) : new Uint8Array()]);

  const parseF = b => {
    let res = [], o = 0;
    while (o < b.length) {
      const kStart = o, k = decVar(b, o); o = k.idx;
      const n = Number(k.val >> 3n), wt = Number(k.val & 7n);
      let vStart = o, vEnd = o;
      if (wt === 0) vEnd = decVar(b, o).idx; else if (wt === 1) vEnd = o + 8; else if (wt === 5) vEnd = o + 4;
      else if (wt === 2) { const len = decVar(b, o); vStart = len.idx; vEnd = vStart + Number(len.val); }
      res.push({ n, wt, raw: b.slice(kStart, vEnd), val: b.slice(vStart, vEnd) }); o = vEnd;
    }
    return res;
  };

  const patchLoc = pl => concat([
    ...parseF(pl).filter(f => ![1,2,3,4,5,6,11,12].includes(f.n)).map(f => f.raw),
    makeF(1, 0, cfg.lat), makeF(2, 0, cfg.lon), makeF(3, 0, cfg.hAcc), makeF(4, 0, cfg.u4), makeF(5, 0, cfg.alt), makeF(6, 0, cfg.vAcc), makeF(11, 0, cfg.mType), makeF(12, 0, cfg.mConf)
  ]);
  const patchW = wl => concat(parseF(wl).map(f => f.n === 2 && f.wt === 2 ? makeF(2, 2, patchLoc(f.val)) : f.raw));
  const patchC = cl => concat(parseF(cl).map(f => f.n === 5 && f.wt === 2 ? makeF(5, 2, patchLoc(f.val)) : f.raw));
  
  // 关键修复点：剔除原本一刀切的根节点过滤，保留高德所需要的所有多余根字段
  const patchPayload = pl => concat(parseF(pl).map(f => {
    if (f.n === 2 && f.wt === 2) return makeF(2, 2, patchW(f.val));
    if ([22,24].includes(f.n) && f.wt === 2) return makeF(f.n, 2, patchC(f.val));
    return f.raw;
  }));

  const process = () => {
    try {
      let s = { o: 2 }, readP = () => { const len = readU16(body, s.o); s.o += 2; const str = String.fromCharCode(...body.slice(s.o, s.o + len)); s.o += len; return str; };
      const writeP = str => concat([writeU16(str.length), new Uint8Array([...str].map(c => c.charCodeAt(0)))]);
      const loc = readP(), app = readP(), os = readP(), fid = readU32(body, s.o); s.o += 4;
      const len = readU32(body, s.o); s.o += 4;
      const patched = patchPayload(body.slice(s.o, s.o + len));
      return concat([writeU16(readU16(body, 0)), writeP(loc), writeP(app), writeP(os), writeU32(fid), writeU32(patched.length), patched]);
    } catch(e) {}
    if (body[0] === 0 && body[1] === 1 && body.length > 10) {
      const len = readU16(body, 8);
      if (10 + len <= body.length) {
        const patched = patchPayload(body.slice(10, 10 + len));
        return concat([body.slice(0, 8), writeU16(patched.length), patched, body.slice(10 + len)]);
      }
    }
    return patchPayload(body);
  };

  const out = process();
  $done({ headers: { ...(typeof $response !== 'undefined' ? $response.headers : {}), "Content-Type": "application/octet-stream", "Content-Length": String(out.length) }, body: out });
})();
