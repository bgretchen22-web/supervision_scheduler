import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// find the root <div> in index.html
const container = document.getElementById("root")!;
const root = createRoot(container);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
