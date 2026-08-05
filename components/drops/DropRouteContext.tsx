"use client";

import { createContext, useContext, type ReactNode } from "react";

const DropRouteContext = createContext<string | undefined>(undefined);

export function DropRouteProvider({
  dropId,
  children,
}: {
  dropId: string;
  children: ReactNode;
}) {
  return (
    <DropRouteContext.Provider value={dropId}>
      {children}
    </DropRouteContext.Provider>
  );
}

export function useFocusedDropId(): string | undefined {
  return useContext(DropRouteContext);
}
