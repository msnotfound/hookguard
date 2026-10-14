import { app } from "../backend/api/app.js";

export default function handler(request, response) {
  return app(request, response);
}
