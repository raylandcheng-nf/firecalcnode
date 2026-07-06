function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed) {
  const randUniform = seed === null || seed === undefined ? Math.random : mulberry32(Number(seed));
  let spare = null;

  function randNormal(mean, stdDev) {
    if (spare !== null) {
      const val = spare;
      spare = null;
      return mean + stdDev * val;
    }

    let u = 0;
    let v = 0;
    while (u === 0) u = randUniform();
    while (v === 0) v = randUniform();

    const mag = Math.sqrt(-2 * Math.log(u));
    const z0 = mag * Math.cos(2 * Math.PI * v);
    const z1 = mag * Math.sin(2 * Math.PI * v);
    spare = z1;

    return mean + stdDev * z0;
  }

  return {
    normal: randNormal,
  };
}

module.exports = {
  createRng,
};
