import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { DashboardPage } from "./pages/DashboardPage";
import { InvoiceDetailPage } from "./pages/InvoiceDetailPage";
import { AdminFundingPage } from "./pages/AdminFundingPage";
import { WebhooksPage } from "./pages/WebhooksPage";
import { CollabAuthPage } from "./pages/CollabAuthPage";
import { SimulatePage } from "./pages/SimulatePage";
import { PayByLinkPage } from "./pages/PayByLinkPage";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/" element={<DashboardPage />} />
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="/admin/funding" element={<AdminFundingPage />} />
            <Route path="/webhooks" element={<WebhooksPage />} />
            <Route path="/collab-auth" element={<CollabAuthPage />} />
            <Route path="/simulate" element={<SimulatePage />} />
            <Route path="/pay/:slug" element={<PayByLinkPage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
