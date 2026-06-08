// Role types for RBAC
// 'seller' = a SaaS tenant owner (the paying client). They own their org and
// must be able to manage it (create WhatsApp sessions, products, services) —
// i.e. they are a WRITE role, like operator. 'viewer' is the only read-only role.
export type UserRole = 'admin' | 'operator' | 'viewer' | 'seller';

export interface RoleContextType {
  role: UserRole | null;
  setRole: (role: UserRole | null) => void;
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  canWrite: boolean;
}
