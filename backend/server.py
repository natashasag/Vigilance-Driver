from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from database import create_user, find_user_by_email, save_session, get_sessions
import bcrypt
import jwt
import datetime
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))



app = Flask(__name__)
CORS(app, origins=["https://vigilance-driver.vercel.app"])
@app.after_request
def after_request(response):
    response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization")
    response.headers.add("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    return response

SECRET_KEY = "vigilance-driver-secret-key-2026"


def generate_token(user_id, email):
    payload = {
        "user_id": user_id,
        "email": email,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=24)
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def verify_token(token):
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None

@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid request"}), 400

    email = data.get("email", "").strip()
    password = data.get("password", "").strip()

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
    user_id = create_user(email, hashed)

    if not user_id:
        return jsonify({"error": "Email already exists"}), 409

    token = generate_token(user_id, email)
    return jsonify({"token": token, "email": email}), 201

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid request"}), 400

    email = data.get("email", "").strip()
    password = data.get("password", "").strip()

    user = find_user_by_email(email)
    if not user:
        return jsonify({"error": "Invalid email or password"}), 401

    if not bcrypt.checkpw(password.encode("utf-8"), user["password"]):
        return jsonify({"error": "Invalid email or password"}), 401

    token = generate_token(str(user["_id"]), email)
    return jsonify({"token": token, "email": email}), 200


@app.route("/api/session", methods=["POST"])
def save_detection_session():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid request"}), 400

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "Unauthorized"}), 401

    decoded = verify_token(auth.split(" ")[1])
    if not decoded:
        return jsonify({"error": "Invalid token"}), 401

    save_session(decoded["user_id"], data)
    return jsonify({"message": "Session saved"}), 201

@app.route("/api/sessions", methods=["GET"])
def get_detection_sessions():
    
    
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "Unauthorized"}), 401

    decoded = verify_token(auth.split(" ")[1])
    if not decoded:
        return jsonify({"error": "Invalid token"}), 401

    sessions = get_sessions(decoded["user_id"])
    return jsonify(sessions), 200

# Example API route
@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json(silent=True)
    return jsonify({"result": "OK"})

@app.route("/")
def home():
    return "Vigilance Driver Backend Running 🚀"

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
   


    
