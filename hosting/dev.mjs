// 本機啟動靜態站（wrangler dev，埠 1069）。跨平台（Mac/Windows）。
// 狀態一定要存在 repo 外面：wrangler.jsonc 的 assets.directory 是 ".."（整個 repo），
// 預設的 .wrangler/state 在 repo 裡，寫入狀態會被當成資源異動、不斷重新載入。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wrangler = path.join(path.dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
const persistTo = path.join(os.tmpdir(), "wrangler-state", "worldgym-web");

const child = spawn(process.execPath, [wrangler, "dev", "--port", "1069", "--persist-to", persistTo, ...process.argv.slice(2)], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
