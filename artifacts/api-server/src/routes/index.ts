import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tracksRouter from "./tracks.js";
import spotifyRouter from "./spotify.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tracksRouter);
router.use(spotifyRouter);

export default router;
