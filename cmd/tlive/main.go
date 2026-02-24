package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var (
	port        int
	idleTimeout int
)

var rootCmd = &cobra.Command{
	Use:   "tlive [command] [args...]",
	Short: "TermLive - Terminal live streaming tool",
	Long:  "Wrap terminal commands for remote monitoring and interaction via Web UI.",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runCommand,
}

func init() {
	rootCmd.Flags().IntVarP(&port, "port", "p", 8080, "Web server port")
	rootCmd.Flags().IntVarP(&idleTimeout, "timeout", "t", 30, "Idle notification timeout (seconds)")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
