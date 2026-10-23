const USERS = [{ id: 1, name: "Ada" }];
export function getUsr(id) {
  return USERS.find((u) => u.id === id) ?? null;
}
