import React, { createContext, useContext } from 'react';
import { AppRoute } from '../types/auth';

interface RouteNavigationContextValue {
  activeRoute: AppRoute;
  navigateRoute: (route: AppRoute) => void;
}

const RouteNavigationContext = createContext<RouteNavigationContextValue | null>(null);

export const RouteNavigationProvider: React.FC<{
  activeRoute: AppRoute;
  navigateRoute: (route: AppRoute) => void;
  children: React.ReactNode;
}> = ({ activeRoute, navigateRoute, children }) => (
  <RouteNavigationContext.Provider value={{ activeRoute, navigateRoute }}>
    {children}
  </RouteNavigationContext.Provider>
);

export function useRouteNavigation(): RouteNavigationContextValue | null {
  return useContext(RouteNavigationContext);
}
