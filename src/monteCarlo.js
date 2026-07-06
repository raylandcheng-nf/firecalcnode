const { validateFireInputs, validateMonteCarloParams } = require("./validation");
const { projectRetirement } = require("./projections");
const { createRng } = require("./random");

function runMonteCarlo(input, params, projectionArg) {
  const data = validateFireInputs({ ...input });
  const sim = validateMonteCarloParams({ ...params });

  const targetAges = [75, 80, 85, 90, 95, 100];
  const simulationHorizonAge = 200;

  const projection = projectionArg || projectRetirement(data);
  if (!projection.retired || projection.retirementAge === null) {
    const probs = {};
    targetAges.forEach((age) => {
      probs[age] = 0;
    });
    return {
      iterations: sim.iterations,
      retirementAge: null,
      startingPortfolio: null,
      targetAgeProbabilities: probs,
      neverRunOutProbability: 0,
      simulationHorizonAge,
    };
  }

  const rng = createRng(sim.seed);
  const retirementAge = projection.retirementAge;
  const startingPortfolio = projection.finalPortfolio;

  const successCounts = {};
  targetAges.forEach((age) => {
    successCounts[age] = 0;
  });

  let neverRunOutCount = 0;

  for (let i = 0; i < sim.iterations; i += 1) {
    let spend = data.annualSpend;
    let portfolio = startingPortfolio;
    let depletionAge = null;

    if (spend > 0) {
      for (let currentAge = retirementAge + 1; currentAge <= simulationHorizonAge; currentAge += 1) {
        let sampledReturn = rng.normal(data.expectedReturnRate, sim.returnStdDev);
        let sampledInflation = rng.normal(data.inflationRate, sim.inflationStdDev);

        sampledReturn = Math.max(sampledReturn, -0.95);
        sampledInflation = Math.max(sampledInflation, -0.95);

        portfolio = portfolio * (1 + sampledReturn) - spend;
        if (portfolio <= 0) {
          depletionAge = currentAge;
          break;
        }
        spend *= 1 + sampledInflation;
      }
    }

    if (depletionAge === null) {
      neverRunOutCount += 1;
    }

    targetAges.forEach((targetAge) => {
      if (targetAge <= retirementAge) {
        successCounts[targetAge] += 1;
      } else if (depletionAge === null || depletionAge > targetAge) {
        successCounts[targetAge] += 1;
      }
    });
  }

  const targetAgeProbabilities = {};
  targetAges.forEach((targetAge) => {
    targetAgeProbabilities[targetAge] = successCounts[targetAge] / sim.iterations;
  });

  return {
    iterations: sim.iterations,
    retirementAge,
    startingPortfolio,
    targetAgeProbabilities,
    neverRunOutProbability: neverRunOutCount / sim.iterations,
    simulationHorizonAge,
  };
}

module.exports = {
  runMonteCarlo,
};
