import { writeFileSync } from "node:fs";
writeFileSync("fixture-backend.pid", String(process.pid));
setInterval(() => {}, 1000);
