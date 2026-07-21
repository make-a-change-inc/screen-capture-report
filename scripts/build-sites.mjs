import { cp, mkdir, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/.openai", { recursive: true });
await cp("admin-web/worker", "dist/server", { recursive: true });
await writeFile(
  "dist/.openai/hosting.json",
  `${JSON.stringify({
    project_id: "appgprj_6a5e36d59e7881919d073ab9466c3734",
  }, null, 2)}\n`,
);
await writeFile(
  "dist/package.json",
  `${JSON.stringify({
    name: "work-visibility-ai-admin-mock",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "server/index.js",
  }, null, 2)}\n`,
);
