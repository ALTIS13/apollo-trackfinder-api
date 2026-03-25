import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tracksRouter from "./tracks.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tracksRouter);

export default router;
