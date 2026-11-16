import { createContext, useContext, useEffect, useState } from 'react';
import { restoreSession, login as doLogin, logout as doLogout } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);   // undefined = still checking, null = signed out
  useEffect(() => { restoreSession().then(setUser).catch(() => setUser(null)); }, []);
  const value = {
    user,
    login: async (email, password) => setUser(await doLogin(email, password)),
    logout: async () => { await doLogout(); setUser(null); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
