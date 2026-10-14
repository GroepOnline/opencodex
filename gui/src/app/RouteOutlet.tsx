import { lazy } from "react";
import type { Route } from "../app-routing";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const Providers = lazy(() => import("./pages/Providers"));
const Models = lazy(() => import("./pages/Models"));
const Combos = lazy(() => import("./pages/Combos"));
const Subagents = lazy(() => import("./pages/Subagents"));
const Verkeer = lazy(() => import("./pages/Verkeer"));
const Debug = lazy(() => import("./pages/Debug"));
const Usage = lazy(() => import("./pages/Usage"));
const Storage = lazy(() => import("./pages/Storage"));
const ApiKeys = lazy(() => import("./pages/ApiKeys"));
const Claude = lazy(() => import("./pages/Claude"));
const Grok = lazy(() => import("./pages/Grok"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Startup = lazy(() => import("./pages/Startup"));

/** Dedicated rendering boundary: app shell owns polling and chrome, not screens. */
export default function RouteOutlet({ route }: { route: Route }) {
  return (
    <>
                    {route.view === "dashboard" && (
                      <Dashboard apiBase={API_BASE} />
                    )}
                    {route.view === "leveranciers" && route.sub === null && (
                      <Providers apiBase={API_BASE} />
                    )}
                    {route.view === "leveranciers" &&
                      route.sub === "claude" && <Claude apiBase={API_BASE} />}
                    {route.view === "leveranciers" && route.sub === "grok" && (
                      <Grok apiBase={API_BASE} />
                    )}
                    {route.view === "modellen" && route.sub === null && (
                      <Models apiBase={API_BASE} />
                    )}
                    {route.view === "modellen" && route.sub === "combos" && (
                      <Combos key={API_BASE} apiBase={API_BASE} />
                    )}
                    {route.view === "modellen" && route.sub === "subagents" && (
                      <Subagents key={API_BASE} apiBase={API_BASE} />
                    )}
                    {route.view === "verkeer" && route.sub === "debug" && (
                      <Debug apiBase={API_BASE} />
                    )}
                    {route.view === "verkeer" && route.sub !== "debug" && (
                      <Verkeer apiBase={API_BASE} />
                    )}
                    {route.view === "verbruik" && <Usage apiBase={API_BASE} />}
                    {route.view === "systeem" && route.sub === null && (
                      <Startup apiBase={API_BASE} />
                    )}
                    {route.view === "systeem" && route.sub === "storage" && (
                      <Storage apiBase={API_BASE} />
                    )}
                    {route.view === "systeem" && route.sub === "api" && (
                      <ApiKeys apiBase={API_BASE} />
                    )}
    </>
  );
}
