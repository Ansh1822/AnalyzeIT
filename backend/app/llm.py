"""Groq client. One place to change the model."""
import os
from langchain_groq import ChatGroq


def ask(system: str, user: str, temperature: float = 0.0) -> str:
    llm = ChatGroq(
        model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        temperature=temperature,
        api_key=os.getenv("GROQ_API_KEY"),
        max_retries=3,
    )
    msg = llm.invoke([("system", system), ("human", user)])
    return msg.content
