// Test helper, loaded with --import: records every fetch a hook tries (and blocks it), so a test can prove what
// would leave the machine.
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => { appendFileSync(process.env.NET_LOG, `${String(url?.url ?? url)}\n`); throw new Error("network blocked in test"); };
