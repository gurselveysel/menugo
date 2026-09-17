'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { Scope } from '../src/cart-protocol';
import { useSharedCart, type SharedCart } from './useSharedCart';

const Context = createContext<SharedCart | null>(null);
export function SharedCartProvider({ scope, children }: { scope: Scope; children: ReactNode }) {
  const cart = useSharedCart(scope);
  return <Context.Provider value={cart}>{children}</Context.Provider>;
}
export function useCart(): SharedCart {
  const cart = useContext(Context);
  if (!cart) throw new Error('SharedCartProvider is required');
  return cart;
}
