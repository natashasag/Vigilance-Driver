from pymongo import MongoClient
from bson.objectid import ObjectId

MongoClient(os.environ.get("mongodb+srv://natashasag:<db_password>@cluster0.grku4ke.mongodb.net/?appName=Cluster0"))_
db = client["vigilance_driver"]
users_collection = db["users"]
sessions_collection = db["sessions"]


def create_user(email, hashed_password):
    if users_collection.find_one({"email": email}):
        return None
    result = users_collection.insert_one({
        "email": email,
        "password": hashed_password
    })
    return str(result.inserted_id)


def find_user_by_email(email):
    return users_collection.find_one({"email": email})


def save_session(user_id, data):
    data["user_id"] = user_id
    return sessions_collection.insert_one(data)


def get_sessions(user_id):
    sessions = sessions_collection.find({"user_id": user_id})
    result = []
    for s in sessions:
        s["_id"] = str(s["_id"])
        result.append(s)
    return result
