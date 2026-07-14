import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Не найден корневой элемент приложения");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
