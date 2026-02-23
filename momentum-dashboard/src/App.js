import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import MomentumDashboard from "./pages/momentumdashboard";
import ScannerConfigPage from "./pages/scannerconfigpage";
import StockPurchaseCalculator from "./pages/stockpurchasecalculator";
import SimulatorPage from "./pages/simulatorpage";


function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MomentumDashboard />} />
        <Route path="/config" element={<ScannerConfigPage />} />
        <Route path="/calc" element={<StockPurchaseCalculator />} />
        <Route path="/simulator" element={<SimulatorPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;