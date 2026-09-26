export const dollars = (v: number) => `$${Math.round(v).toLocaleString()}`;
export const dollarsK = (v: number) => `$${Math.round(v / 1000)}k`;