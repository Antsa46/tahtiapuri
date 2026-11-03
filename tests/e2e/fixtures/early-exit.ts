import { writeFileSync } from "node:fs";
writeFileSync("fixture-backend.pid", String(process.pid));
process.exit(23);
