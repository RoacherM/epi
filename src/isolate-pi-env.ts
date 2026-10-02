// Side-effect module: cli.ts imports it first, so it is evaluated before any module that loads Pi
// (ES modules evaluate in import order). See src/pi-env.ts.
import { isolatePiEnvironment } from "./pi-env.js";

isolatePiEnvironment(process.env);
