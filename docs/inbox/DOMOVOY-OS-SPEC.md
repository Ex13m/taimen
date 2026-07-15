# DOMOVOY OS — мастер-спека хозяина (получена 2026-07-15)

> Сохранено дословно из DOCX. Разбор заимствований — в STRATEGY-GALAXY.md §9.

MASTER SPECIFICATION FOR CODEXProject: DOMOVOY OS
Mission
You are the Chief Architect of DOMOVOY OS.This is NOT a chatbot. It is an autonomous personal AI operating system and orchestration platform.Do not start by writing application code.Design the complete system first.Every architectural decision must be documented before implementation.The system must be modular, scalable, secure and production-ready.
Product Vision
Create a living AI ecosystem with a single interface: an animated Orb.The Orb is the only visible UI.Everything else happens through natural conversation, voice, proactive suggestions and autonomous agents.The system should:• Remember everything the user allows.• Connect ideas together.• Manage projects.• Analyze finances.• Optimize time.• Search the web.• Generate text, images, music and video.• Coordinate many specialized AI agents.• Learn from interactions.• Improve workflows over time.• Use MCP-compatible tools and external APIs.
Rules
1. Architecture first.2. Documentation before implementation.3. Modular microservice architecture.4. Every module independently testable.5. Secure by default.6. User controls permissions.7. Long-term memory.8. Continuous self-analysis (behavior improvement), with controlled updates and testing before code changes.
Required Documentation
• PRD.md
• VISION.md
• ARCHITECTURE.md
• DATABASE.md
• MEMORY.md
• AGENTS.md
• MCP.md
• API.md
• SECURITY.md
• UI.md
• DESIGN_SYSTEM.md
• MOTION.md
• ROADMAP.md
• TASKS.md
• DEPLOYMENT.md
• TESTING.md
Repository Structure
DOMOVOY-OS/docs/backend/frontend/orchestrator/agents/memory/integrations/automation/database/tests/docker/scripts/
Technology Stack
Frontend: Next.js, React, TypeScript, Tailwind CSS, Framer Motion.Backend: Python, FastAPI.Database: PostgreSQL, pgvector, Redis.Agent orchestration: LangGraph (or equivalent).Models: Claude (primary), GPT, Gemini, local LLMs.Integrations: MCP, Gmail, Calendar, Drive, GitHub, Notion and others.
Core Agents
• Chief Orchestrator
• Memory Agent
• Research Agent
• Finance Agent
• Planner Agent
• Developer Agent
• Media Agent
• Automation Agent
• Idea Synthesizer
• Quality/Critic Agent
• Security Agent
Development Order
1. Create all documentation.
2. Review architecture.
3. Generate repository.
4. Implement backend.
5. Implement frontend.
6. Implement Orb dashboard.
7. Implement agent framework.
8. Implement integrations.
9. Testing.
10. Release candidate.
Final Goal
Build a production-grade AI operating system that acts as a second brain,coordinates specialized agents, proactively assists the user, and evolves throughdocumented, controlled improvements rather than uncontrolled self-modification.
