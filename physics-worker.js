const YOSHIDA = (() => {
  const w1 = 1 / (2 - Math.pow(2, 1 / 3));
  return [w1, w1, 1 - 2 * w1, w1];
})();

function computeAcc(positions, masses, n, bodyIndex, G, displayScale, useMinDist) {
  const minDist = 0.5;
  const minSq = minDist * minDist;
  const ds = displayScale;
  let ax = 0,
    ay = 0,
    az = 0;
  const bx = positions[bodyIndex * 3];
  const by = positions[bodyIndex * 3 + 1];
  const bz = positions[bodyIndex * 3 + 2];
  for (let i = 0; i < n; i++) {
    if (i === bodyIndex) continue;
    const dx = (positions[i * 3] - bx) / ds;
    const dy = (positions[i * 3 + 1] - by) / ds;
    const dz = (positions[i * 3 + 2] - bz) / ds;
    let distSq = dx * dx + dy * dy + dz * dz;
    if (useMinDist) distSq = Math.max(distSq, minSq);
    const dist = Math.sqrt(distSq);
    const force = (G * masses[i]) / (dist * distSq);
    ax += force * dx;
    ay += force * dy;
    az += force * dz;
  }
  return { ax, ay, az };
}

function computeCageAcceleration(x, y, z, cage, displayScale) {
  if (!cage.enabled) return { ax: 0, ay: 0, az: 0 };
  const dx = (x - cage.centerX) / displayScale;
  const dy = (y - cage.centerY) / displayScale;
  const dz = (z - cage.centerZ) / displayScale;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-10) return { ax: 0, ay: 0, az: 0 };
  const boundaryR = cage.boundaryRadius / displayScale;
  const warningR = cage.warningRadius / displayScale;
  const rNorm = r / boundaryR;
  if (r < warningR) return { ax: 0, ay: 0, az: 0 };
  if (rNorm >= 1 - cage.softening) {
    const forceMag = (cage.strength * cage.maxMultiplier) / r;
    return {
      ax: (-forceMag * dx) / r,
      ay: (-forceMag * dy) / r,
      az: (-forceMag * dz) / r,
    };
  }
  const effectiveR = r - warningR;
  const effectiveBoundary = boundaryR - warningR;
  const effectiveRNorm = effectiveR / effectiveBoundary;
  const rNormExp = Math.pow(effectiveRNorm, cage.exponent - 1);
  const denom = 1 - Math.pow(effectiveRNorm, cage.exponent) + cage.softening;
  const denomSq = denom * denom;
  const factor = (cage.exponent * rNormExp) / effectiveBoundary / denomSq;
  const forceMag = cage.strength * Math.min(factor, cage.maxMultiplier / r);
  return { ax: -forceMag * dx, ay: -forceMag * dy, az: -forceMag * dz };
}

function computeDamping(x, y, z, vx, vy, vz, cage, displayScale) {
  if (!cage.enabled) return { dampingX: 0, dampingY: 0, dampingZ: 0 };
  const dx = (x - cage.centerX) / displayScale;
  const dy = (y - cage.centerY) / displayScale;
  const dz = (z - cage.centerZ) / displayScale;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const boundaryR = cage.boundaryRadius / displayScale;
  const warningR = cage.warningRadius / displayScale;
  if (r < warningR) return { dampingX: 0, dampingY: 0, dampingZ: 0 };
  const effectiveR = r - warningR;
  const effectiveBoundary = boundaryR - warningR;
  const ratio = effectiveR / effectiveBoundary;
  const dampingStrength = cage.dampingFactor * Math.pow(ratio, 2);
  return {
    dampingX: -dampingStrength * vx,
    dampingY: -dampingStrength * vy,
    dampingZ: -dampingStrength * vz,
  };
}

function computeCageAccelerations(
  positions,
  velocities,
  masses,
  n,
  cage,
  displayScale,
) {
  if (!cage.enabled) return null;
  const accs = new Array(n);
  let totalForceX = 0,
    totalForceY = 0,
    totalForceZ = 0,
    totalMass = 0;

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const vx = velocities[i * 3];
    const vy = velocities[i * 3 + 1];
    const vz = velocities[i * 3 + 2];

    const cageAcc = computeCageAcceleration(x, y, z, cage, displayScale);
    const damping = computeDamping(x, y, z, vx, vy, vz, cage, displayScale);

    const ax = cageAcc.ax + damping.dampingX;
    const ay = cageAcc.ay + damping.dampingY;
    const az = cageAcc.az + damping.dampingZ;

    accs[i] = { ax, ay, az };
    totalForceX += ax * masses[i];
    totalForceY += ay * masses[i];
    totalForceZ += az * masses[i];
    totalMass += masses[i];
  }

  const compAx = -totalForceX / totalMass;
  const compAy = -totalForceY / totalMass;
  const compAz = -totalForceZ / totalMass;

  for (let i = 0; i < n; i++) {
    accs[i].ax += compAx;
    accs[i].ay += compAy;
    accs[i].az += compAz;
  }

  return accs;
}

self.onmessage = function (e) {
  const data = e.data;
  const positions = new Float32Array(data.positions);
  const velocities = new Float32Array(data.velocities);
  const masses = new Float32Array(data.masses);
  const n = data.n;
  const G = data.G;
  const dt = data.dt;
  const displayScale = data.displayScale;
  const useMinDist = data.useMinDist;
  const cage = data.cageParams;

  for (let stepIndex = 0; stepIndex < YOSHIDA.length; stepIndex++) {
    const w = YOSHIDA[stepIndex];
    const h = dt * w;
    const cageAccs = computeCageAccelerations(
      positions,
      velocities,
      masses,
      n,
      cage,
      displayScale,
    );

    for (let i = 0; i < n; i++) {
      const acc = computeAcc(
        positions,
        masses,
        n,
        i,
        G,
        displayScale,
        useMinDist,
      );
      let ax = acc.ax,
        ay = acc.ay,
        az = acc.az;
      if (cageAccs) {
        ax += cageAccs[i].ax;
        ay += cageAccs[i].ay;
        az += cageAccs[i].az;
      }
      velocities[i * 3] += ax * h;
      velocities[i * 3 + 1] += ay * h;
      velocities[i * 3 + 2] += az * h;
    }

    for (let i = 0; i < n; i++) {
      positions[i * 3] += velocities[i * 3] * h * displayScale;
      positions[i * 3 + 1] += velocities[i * 3 + 1] * h * displayScale;
      positions[i * 3 + 2] += velocities[i * 3 + 2] * h * displayScale;
    }
  }

  self.postMessage(
    {
      positions: positions.buffer,
      velocities: velocities.buffer,
    },
    [positions.buffer, velocities.buffer],
  );
};
