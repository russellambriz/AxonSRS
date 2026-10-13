import json
from datetime import datetime, timezone, timedelta
from fsrs import Scheduler, Card, Rating
s = Scheduler(enable_fuzzing=False)
M = 1/1440
seqs = {
 # offsets are cumulative days from t0; reviews after learning keep the same time of day
 'good-chain': [(0,'Good'),(10*M,'Good'),(1+10*M,'Good'),(4+10*M,'Good'),(15+10*M,'Good'),(60+10*M,'Good')],
 'lapse-relearn': [(0,'Again'),(1*M,'Good'),(11*M,'Good'),(2+11*M,'Good'),(10+11*M,'Again'),(10+21*M,'Good'),(13+21*M,'Good')],
 'easy-first': [(0,'Easy'),(8,'Easy'),(40,'Hard'),(70,'Good')],
 'hard-mix': [(0,'Hard'),(6*M,'Good'),(1+6*M,'Hard'),(3+6*M,'Good'),(12+6*M,'Easy')],
 'overdue': [(0,'Good'),(10*M,'Good'),(30+10*M,'Good'),(200+10*M,'Again'),(200+20*M,'Good')],
}
cases = []
for name, seq in seqs.items():
    card = Card(card_id=1)
    t0 = datetime(2026,1,5,12,0,0,tzinfo=timezone.utc)
    steps = []
    for day, r in seq:
        now = t0 + timedelta(days=day)
        now = now.replace(microsecond=0)
        card, log = s.review_card(card, getattr(Rating, r), now)
        steps.append({'at': int(round(now.timestamp()*1000)), 'rating': int(getattr(Rating, r)), 'state': int(card.state), 'stability': card.stability, 'difficulty': card.difficulty, 'due': int(round(card.due.timestamp()*1000))})
    cases.append({'name': name, 'steps': steps})
json.dump({'generator': 'py-fsrs 6.3.2 (Scheduler(enable_fuzzing=False), default parameters)', 'cases': cases}, open('ref_cases.json','w'), indent=1)
