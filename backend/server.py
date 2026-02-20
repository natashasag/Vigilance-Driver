from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

from database import create_user, find_user_by_email, save_session, get_sessions
import bcrypt
import jwt
import datetime
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))



app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "https://vigilance-driver.vercel.app"}})

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
   
@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True)
if not data:
    return jsonify({"error": "Invalid request"}), 400
   

@app.route("/api/session", methods=["POST"])
data = request.get_json(silent=True)
def save_detection_session():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "Unauthorized"}), 401

    decoded = verify_token(auth.split(" ")[1])
    if not decoded:
        return jsonify({"error": "Invalid token"}), 401

    data = request.json
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
    data = request.json
    return jsonify({"result": "OK"})
@app.route("/")
def home():
    return "Vigilance Driver Backend Running 🚀"

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)


    
@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    return response