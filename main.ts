import { initEnv } from "./src/runtime/env.ts";
import { initRepo } from "./src/repo/index.ts";
import { DenoKvRepo } from "./src/repo/deno.ts";
import { app } from "./src/app.ts";

initEnv((n) => Deno.env.get(n) ?? "");
initRepo(new DenoKvRepo(await Deno.openKv()));
Deno.serve(app.fetch);
