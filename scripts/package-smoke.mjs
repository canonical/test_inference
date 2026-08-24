import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const temporaryDirectory = mkdtempSync(join(tmpdir(), `test-inference-package-`));
const packageOutput = execFileSync(`npm`, [`pack`, `--json`, `--pack-destination`, temporaryDirectory], {
  encoding: `utf8`,
});
const packageMetadata = JSON.parse(packageOutput.slice(packageOutput.indexOf(`[`)));
const tarball = join(temporaryDirectory, packageMetadata[0].filename);
const installation = join(temporaryDirectory, `installation`);

execFileSync(`npm`, [`init`, `--yes`], { cwd: temporaryDirectory, stdio: `ignore` });
execFileSync(`npm`, [`install`, `--ignore-scripts`, `--prefix`, installation, tarball], { stdio: `inherit` });

const installedPackage = join(installation, `node_modules`, `@athena`, `test-inference`);
const imported = await import(join(installedPackage, `dist`, `client.js`));

if (typeof imported.createScenarioClient !== `function`) {
  throw new Error(`Packed public API does not export createScenarioClient.`);
}

if (!readFileSync(join(installedPackage, `dist`, `server.js`), `utf8`).startsWith(`#!/usr/bin/env node`)) {
  throw new Error(`Packed server executable has no Node shebang.`);
}

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once(`error`, reject);
  probe.listen(0, `127.0.0.1`, () => {
    const address = probe.address();
    probe.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});

const executable = join(installation, `node_modules`, `.bin`, `test-inference`);
const service = spawn(executable, [], { env: { ...process.env, PORT: String(port) }, stdio: `inherit` });

try {
  let healthy = false;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await promisify(setTimeout)(100);
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);

    if (response?.ok) {
      healthy = true;
      break;
    }
  }

  if (!healthy) {
    throw new Error(`Packed test-inference executable did not become healthy.`);
  }
} finally {
  service.kill(`SIGTERM`);
}
