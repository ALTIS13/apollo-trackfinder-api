import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tracksRouter from "./tracks.js";
import spotifyRouter from "./spotify.js";
import yandexRouter from "./yandex.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tracksRouter);
router.use(spotifyRouter);
router.use(yandexRouter);

export default router;
