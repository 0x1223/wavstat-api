import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles/index.css";

// Defined at module scope so the reference is stable across renders —
// App's useEffect dependency array sees the same function every time.
function removeLoadingGuard() {
  document.documentElement.classList.remove("app-loading");
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App onFirstRender={removeLoadingGuard} />
  </React.StrictMode>,
);
