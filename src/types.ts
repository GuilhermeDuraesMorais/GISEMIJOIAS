export interface Product {
  id: string;
  category: string;
  material: string;
  initialQuantity: number;
  currentQuantity: number;
  unitValue: number;
}

export interface Installment {
  number: number;
  dueDate: string;
  value: number;
  status: 'paid' | 'pending';
}

export interface Sale {
  id?: string;
  date: string;
  productId: string;
  category: string;
  saleValue: number;
  customerName: string;
  paymentMethod: 'cash' | '2x' | '3x';
  installments: Installment[];
}

export interface RawInput {
  id?: string;
  originalText: string;
  status: 'pending' | 'processed' | 'error';
  uploadDate: string;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}
