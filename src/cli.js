const { projectRetirement } = require("./projections");
const { runMonteCarlo } = require("./monteCarlo");
const { validateFireInputs, validateMonteCarloParams } = require("./validation");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const val = argv[i + 1];
    out[key] = val;
    i += 1;
  }
  return out;
}

function n(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return Number(value);
}

function fmtMoney(v) {
  return `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function main() {
  const args = parseArgs(process.argv);

  const fireInputs = validateFireInputs({
    age: n(args.age, 32),
    annualSpend: n(args.spend, 50000),
    currentInvestments: n(args.investments, 180000),
    expectedReturnRate: n(args["return-rate"], 7) / 100,
    inflationRate: n(args["inflation-rate"], 2.5) / 100,
    annualIncome: n(args.income, 95000),
    withdrawalRate: n(args["withdrawal-rate"], 4) / 100,
    maxAge: n(args["max-age"], 80),
    incomeGrowthRate: args["income-growth-rate"] !== undefined ? n(args["income-growth-rate"], 0) / 100 : null,
  });

  const mcParams = validateMonteCarloParams({
    iterations: n(args.iterations, 5000),
    returnStdDev: n(args["return-std-dev"], 15) / 100,
    inflationStdDev: n(args["inflation-std-dev"], 1) / 100,
    seed: args.seed !== undefined ? n(args.seed, 0) : null,
  });

  const projection = projectRetirement(fireInputs);
  const monteCarlo = runMonteCarlo(fireInputs, mcParams, projection);

  console.log("\n=== Deterministic FIRE Estimate ===");
  if (projection.retired) {
    console.log(`Estimated retirement age: ${projection.retirementAge}`);
    console.log(`Years to retirement: ${projection.retirementYearsFromNow}`);
  } else {
    console.log(`FIRE target not reached by age ${fireInputs.maxAge}`);
  }
  console.log(`Portfolio at end of projection: ${fmtMoney(projection.finalPortfolio)}`);
  console.log(`FIRE target at end of projection: ${fmtMoney(projection.finalTarget)}`);

  console.log("\n=== Monte Carlo Simulation ===");
  console.log(`Iterations: ${monteCarlo.iterations}`);

  if (monteCarlo.retirementAge === null || monteCarlo.startingPortfolio === null) {
    console.log("Deterministic retirement point was not reached, so post-retirement longevity was not simulated.");
  } else {
    console.log(`Starting retirement age: ${monteCarlo.retirementAge}`);
    console.log(`Starting retirement portfolio: ${fmtMoney(monteCarlo.startingPortfolio)}`);
    console.log("Probability portfolio lasts to each target age:");
    Object.keys(monteCarlo.targetAgeProbabilities)
      .map((x) => Number(x))
      .sort((a, b) => a - b)
      .forEach((age) => {
        const p = monteCarlo.targetAgeProbabilities[age];
        console.log(`  Age ${age}: ${(p * 100).toFixed(1)}%`);
      });
    console.log(
      `Probability portfolio never runs out (through age ${monteCarlo.simulationHorizonAge}): ${(monteCarlo.neverRunOutProbability * 100).toFixed(1)}%`
    );
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
