import spawn from "cross-spawn";
const api = spawn(
  "pnpm",
  ["exec", "tsx", "watch", "src/interfaces/cli.ts", "serve", "--dev"],
  { stdio: "inherit", windowsHide: true },
);
const ui = spawn("pnpm", ["exec", "vite"], {
  stdio: "inherit",
  windowsHide: true,
});
const close = () => {
  api.kill();
  ui.kill();
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
api.on("exit", () => {
  ui.kill();
});
ui.on("exit", () => {
  api.kill();
});
