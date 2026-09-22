import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/adapters/storage.js";
import { Workbench } from "../src/application/workbench.js";
export async function fixture(baseUrl = "http://127.0.0.1:4320/") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "good-verify-test-"));
  const root = path.join(dir, "target");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "source.txt"), "version one");
  const workbench = new Workbench(new Store(path.join(dir, "data")), true);
  await workbench.init();
  const project = await workbench.connect({
    name: "Generic target",
    root,
    baseUrl,
    commands: [
      {
        id: "check",
        label: "Generic check",
        program: process.execPath,
        args: ["-e", 'console.log("checked")'],
      },
      {
        id: "fail",
        label: "Failing check",
        program: process.execPath,
        args: ["-e", "process.exit(1)"],
      },
      {
        id: "slow",
        label: "Cancellable check",
        program: process.execPath,
        args: ["-e", "setTimeout(()=>{},60000)"],
        timeoutMs: 1000,
      },
    ],
  });
  return {
    dir,
    root,
    workbench,
    project,
    async close() {
      await workbench.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
