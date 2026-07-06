const fs = require("fs/promises");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

async function copyDir(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function copyIfExists(relativePath) {
  const srcPath = path.join(rootDir, relativePath);
  const destPath = path.join(distDir, relativePath);

  try {
    const stats = await fs.stat(srcPath);
    if (stats.isFile()) {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    } else if (stats.isDirectory()) {
      await copyDir(srcPath, destPath);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
}

async function build() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  await copyIfExists("src");
  await copyIfExists("views");
  await copyIfExists("package.json");
  await copyIfExists("package-lock.json");
  await copyIfExists("README.md");
  await copyIfExists(".env.example");

  const buildInfo = [
    "FIRE Monte Carlo Node build artifact",
    `Built at: ${new Date().toISOString()}`,
    "Install runtime dependencies in dist using: npm ci --omit=dev",
  ].join("\n");

  await fs.writeFile(path.join(distDir, "BUILD_INFO.txt"), `${buildInfo}\n`, "utf8");

  console.log("Build complete.");
  console.log(`Output: ${distDir}`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
