function Team() {
  const members = [
    {
      name: 'Shravani Holla M',
      role: 'Team Lead',
      emoji: '👩‍💼',
      desc: 'Leads the SmartRoad AI team, coordinates project activities, and drives the overall vision and execution of the solution.',
      skills: ['Team Leadership', 'Coordination', 'Project Planning'],
      color: '#3b82f6'
    },
    {
      name: 'Sanidhya Rai',
      role: 'Co-Lead · Technical & Backend Lead',
      emoji: '👩‍💻',
      desc: 'Leads technical development and backend engineering, oversees system architecture, and drives AI/ML integration across the platform.',
      skills: ['Backend Development', 'System Architecture', 'AI/ML Integration'],
      color: '#8b5cf6'
    },
    {
      name: 'Shreya',
      role: 'Frontend & UI Support',
      emoji: '🎨',
      desc: 'Supports the development and refinement of the user interface, helping make SmartRoad AI clear, accessible, and easy to use.',
      skills: ['Frontend Support', 'UI Design', 'Responsive Layouts'],
      color: '#06b6d4'
    },
    {
      name: 'Avani Prabhu',
      role: 'Research & Documentation',
      emoji: '📚',
      desc: 'Supports project research, organizes technical information, and prepares clear documentation and presentation materials.',
      skills: ['Research', 'Documentation', 'Presentation'],
      color: '#10b981'
    },
    {
      name: 'Vasudev',
      role: 'Testing & Integration Support',
      emoji: '🧪',
      desc: 'Assists with testing project features, checking workflows, and supporting integration to improve overall reliability.',
      skills: ['Testing', 'Quality Checks', 'Integration Support'],
      color: '#f59e0b'
    }
  ]

  return (
    <section className="section team-section" id="team-section">
      <div className="container">
        <div className="section-header">
          <span className="section-tag">The People</span>
          <h2 className="section-title">Meet the <span className="accent">Team</span></h2>
          <p className="section-subtitle">A collaborative team working to make Indian roads safer through the power of artificial intelligence.</p>
        </div>
        <div className="cards-grid cards-5">
          {members.map((m, i) => (
            <div className="glass-card team-card" key={i} style={{ '--team-color': m.color }}>
              <div className="team-avatar" style={{ background: `linear-gradient(135deg, ${m.color}33, ${m.color}11)`, borderColor: m.color + '44' }}>
                <span className="team-emoji">{m.emoji}</span>
              </div>
              <h3 className="team-name">{m.name}</h3>
              <span className="team-role" style={{ color: m.color }}>{m.role}</span>
              <p className="team-desc">{m.desc}</p>
              <div className="team-skills">
                {m.skills.map((s, j) => (
                  <span className="skill-tag" key={j} style={{ borderColor: m.color + '44', color: m.color }}>{s}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default Team
