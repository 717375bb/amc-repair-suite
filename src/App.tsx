import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './layouts/AppLayout'
import RepairOrders from './pages/RepairOrders'
import EmailQuoteAnalysis from './pages/EmailQuoteAnalysis'
import OpenOrderTracking from './pages/OpenOrderTracking'
import Discrepancies from './pages/Discrepancies'
import BackshopRepairs from './pages/BackshopRepairs'
import ScrappedParts from './pages/ScrappedParts'
import QuotesReports from './pages/QuotesReports'
import WarrantyAssessment from './pages/WarrantyAssessment'
import VendorKpiReports from './pages/VendorKpiReports'
import StatisticalModels from './pages/StatisticalModels'

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/repair-orders" replace />} />
        <Route path="/repair-orders" element={<RepairOrders />} />
        <Route path="/open-orders" element={<OpenOrderTracking />} />
        <Route path="/backshop-repairs" element={<BackshopRepairs />} />
        <Route path="/scrapped-parts" element={<ScrappedParts />} />
        <Route path="/email-quotes" element={<EmailQuoteAnalysis />} />
        <Route path="/quotes-reports" element={<QuotesReports />} />
        <Route path="/discrepancies" element={<Discrepancies />} />
        <Route path="/warranty-assessment" element={<WarrantyAssessment />} />
        <Route path="/vendor-kpi" element={<VendorKpiReports />} />
        <Route path="/statistical-models" element={<StatisticalModels />} />
      </Route>
    </Routes>
  )
}

export default App
