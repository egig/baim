export interface User {
  id: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  userId: string;
  keyHash: string;
  creditBalance: number;
  createdAt: string;
}
