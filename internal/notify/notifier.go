package notify

type NotifyMessage struct {
	SessionID   string
	Command     string
	Pid         int
	Duration    string
	LastOutput  string
	WebURL      string
	IdleSeconds int
}

type Notifier interface {
	Send(msg *NotifyMessage) error
}

type MultiNotifier struct {
	notifiers []Notifier
}

func NewMultiNotifier(notifiers ...Notifier) *MultiNotifier {
	return &MultiNotifier{notifiers: notifiers}
}

func (m *MultiNotifier) Send(msg *NotifyMessage) error {
	var firstErr error
	for _, n := range m.notifiers {
		if err := n.Send(msg); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
