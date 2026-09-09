import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth, Permission } from "@/context/AuthContext";
import { Spinner } from "@/components/ui/primitives";
import AppLayout from "@/components/layout/AppLayout";

import SignIn from "@/pages/auth/SignIn";
import SignUp from "@/pages/auth/SignUp";
import VerifyOtp from "@/pages/auth/VerifyOtp";
import ForgotPassword from "@/pages/auth/ForgotPassword";
import ResetPassword from "@/pages/auth/ResetPassword";
import OAuthCallback from "@/pages/auth/OAuthCallback";

/**
 * Application screens load on demand.
 *
 * Everything used to be in one bundle — 943 KB, most of it the charting library
 * that only the dashboard needs. That whole payload had to download, parse and
 * execute before the sign-in form appeared, and it is a real part of "sections
 * take too long to load". Splitting on the route boundary means a screen costs
 * its own code and nothing else's.
 */
const Dashboard = lazy(() => import("@/pages/app/Dashboard"));
const Inventory = lazy(() => import("@/pages/app/Inventory"));
const Replenishment = lazy(() => import("@/pages/app/Replenishment"));
const ImportCenter = lazy(() => import("@/pages/app/ImportCenter"));
const Products = lazy(() => import("@/pages/app/Products"));
const ProductDetail = lazy(() => import("@/pages/app/ProductDetail"));
const Alerts = lazy(() => import("@/pages/app/Alerts"));
const Forecast = lazy(() => import("@/pages/app/Forecast"));
const Orders = lazy(() => import("@/pages/app/Orders"));
const OrderCatalog = lazy(() => import("@/pages/app/OrderCatalog"));
const MyOrders = lazy(() => import("@/pages/app/MyOrders"));
const WarehouseBoard = lazy(() => import("@/pages/app/warehouse/WarehouseBoard"));
const Transfers = lazy(() => import("@/pages/app/Transfers"));
const Insights = lazy(() => import("@/pages/app/Insights"));
const Analytics = lazy(() => import("@/pages/app/Analytics"));
const Reports = lazy(() => import("@/pages/app/Reports"));
const WhatIf = lazy(() => import("@/pages/app/WhatIf"));
const Profile = lazy(() => import("@/pages/app/Profile"));

const AdminHome = lazy(() => import("@/pages/app/admin/AdminHome"));
const Users = lazy(() => import("@/pages/app/admin/Users"));
const Stores = lazy(() => import("@/pages/app/admin/Stores"));
const Suppliers = lazy(() => import("@/pages/app/admin/Suppliers"));
const Branding = lazy(() => import("@/pages/app/admin/Branding"));
const Media = lazy(() => import("@/pages/app/admin/Media"));
const Announcements = lazy(() => import("@/pages/app/admin/Announcements"));
const SystemSettings = lazy(() => import("@/pages/app/admin/SystemSettings"));
const AuditLogs = lazy(() => import("@/pages/app/admin/AuditLogs"));

function Protected({ children, permission }: {
  children: React.ReactNode;
  permission?: Permission;
}) {
  const { user, loading, can } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  if (!user) return <Navigate to="/sign-in" replace />;
  if (permission && !can(permission)) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  return user ? <Navigate to="/app" replace /> : <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />

      <Route path="/sign-in" element={<PublicOnly><SignIn /></PublicOnly>} />
      <Route path="/sign-up" element={<PublicOnly><SignUp /></PublicOnly>} />
      <Route path="/verify" element={<VerifyOtp purpose="signup" />} />
      <Route path="/verify-reset" element={<VerifyOtp purpose="recovery" />} />
      <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/auth/callback" element={<OAuthCallback />} />

      <Route
        path="/app"
        element={
          <Protected>
            <AppLayout />
          </Protected>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="replenishment" element={<Replenishment />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductDetail />} />
        <Route path="forecast" element={<Forecast />} />
        <Route path="order" element={
          <Protected permission="order_products"><OrderCatalog /></Protected>} />
        <Route path="my-orders" element={
          <Protected permission="order_products"><MyOrders /></Protected>} />
        <Route path="warehouse" element={
          <Protected permission="fulfil_orders"><WarehouseBoard /></Protected>} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<Orders />} />
        <Route path="transfers" element={<Transfers />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="reports" element={<Reports />} />
        <Route path="insights" element={<Insights />} />
        <Route path="what-if" element={<WhatIf />} />
        <Route path="profile" element={<Profile />} />

        <Route path="admin" element={
          <Protected permission="manage_users"><AdminHome /></Protected>} />
        <Route path="admin/imports" element={
          <Protected permission="import_data"><ImportCenter /></Protected>} />
        <Route path="admin/users" element={
          <Protected permission="manage_users"><Users /></Protected>} />
        <Route path="admin/stores" element={
          <Protected permission="manage_stores"><Stores /></Protected>} />
        <Route path="admin/suppliers" element={
          <Protected permission="manage_suppliers"><Suppliers /></Protected>} />
        <Route path="admin/branding" element={
          <Protected permission="manage_settings"><Branding /></Protected>} />
        <Route path="admin/media" element={
          <Protected permission="manage_settings"><Media /></Protected>} />
        <Route path="admin/announcements" element={
          <Protected permission="manage_settings"><Announcements /></Protected>} />
        <Route path="admin/settings" element={
          <Protected permission="manage_settings"><SystemSettings /></Protected>} />
        <Route path="admin/audit" element={
          <Protected permission="view_audit"><AuditLogs /></Protected>} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}