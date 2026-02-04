import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import MomentumDashboard from "./pages/MomentumDashboard";
import ScannerConfigPage from "./pages/ScannerConfigPage"; 
import StockPurchaseCalculator from "./pages/StockPurchaseCalculator";
import SimulatorPage from "./pages/SimulatorPage";


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