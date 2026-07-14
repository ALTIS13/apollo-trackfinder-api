import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import App from "./App";
import { createDashboardAdapterForEnvironment } from "./data/dashboard-adapter";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Не найден корневой элемент приложения");
const adapter = createDashboardAdapterForEnvironment(import.meta.env.VITE_ADMIN_API_URL);

createRoot(root).render(
  <StrictMode>
    <App adapter={adapter} />
  </StrictMode>,
);
